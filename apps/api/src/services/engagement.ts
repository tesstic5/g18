// apps/api/src/services/engagement.ts — the WRITE side of the engagement
// features. These Redis structures were previously only ever READ:
//
//   • lb:{daily,weekly}:{key} / lb:all_time  → /leaderboard/* (always empty)
//   • feed:game:{slug} / feed:lobby:bigwins  → /games/:slug/live-feed (always empty)
//   • resp:daily_loss:{user}:{date}          → responsiblePlayGuard (never tripped)
//   • WinStreak rows                          → milestone bonuses (never awarded)
//
// Every function here is FAIL-OPEN and fire-and-forget: engagement metadata must
// never fail or slow down a settled bet. Call `recordEngagement()` after the
// settlement transaction has committed.
import { prisma } from '../db/prisma';
import { redis, keys } from '../db/redis';
import { maskUsername } from '@casino/game-core/mask';
import { dayKey, startOfWeek } from '../lib/day-boundary';

const LB_TTL_DAILY = 60 * 60 * 24 * 8; // keep a day's board ~8 days
const LB_TTL_WEEKLY = 60 * 60 * 24 * 35; // keep a week's board ~5 weeks
const FEED_MAX = 50;

/** Platform-day key in the configured time zone, e.g. "2026-08-16". */
export function dailyKey(d = new Date()): string {
  return dayKey(d);
}

/** ISO-ish week key anchored to Monday, e.g. "2026-08-10". */
export function weeklyKey(d = new Date()): string {
  return dayKey(startOfWeek(d));
}

export interface RoundOutcome {
  userId: string;
  displayName?: string | null;
  gameSlug: string;
  betAmount: number;
  payoutAmount: number;
  isWin: boolean;
  demo: boolean;
}

/**
 * Record all engagement side-effects for a settled round.
 * Never throws — every branch is individually guarded.
 */
export async function recordEngagement(outcome: RoundOutcome): Promise<void> {
  if (outcome.demo) return; // demo rounds count for nothing (docs/20 §9)
  await Promise.allSettled([
    bumpLeaderboards(outcome),
    pushLiveFeed(outcome),
    trackDailyLoss(outcome),
    touchActivity(outcome.userId),
  ]);
}

/** Leaderboards are scored by total wagered (docs/20 §7). */
async function bumpLeaderboards(o: RoundOutcome): Promise<void> {
  try {
    const multi = redis.multi();
    const daily = keys.lb('daily', dailyKey());
    const weekly = keys.lb('weekly', weeklyKey());
    multi.zincrby(daily, o.betAmount, o.userId);
    multi.expire(daily, LB_TTL_DAILY);
    multi.zincrby(weekly, o.betAmount, o.userId);
    multi.expire(weekly, LB_TTL_WEEKLY);
    multi.zincrby(keys.lb('all_time', ''), o.betAmount, o.userId);
    await multi.exec();
  } catch (e) {
    console.error('[engagement] leaderboard update failed:', (e as Error).message);
  }
}

/** Per-game live feed + the lobby big-win ticker (masked — never full ids). */
async function pushLiveFeed(o: RoundOutcome): Promise<void> {
  if (!o.isWin || o.payoutAmount <= 0) return;
  try {
    const entry = JSON.stringify({
      user: maskUsername(o.displayName || `Player${o.userId.slice(-4)}`),
      game: o.gameSlug,
      betAmount: o.betAmount,
      payoutAmount: o.payoutAmount,
      multiplier: o.betAmount > 0 ? +(o.payoutAmount / o.betAmount).toFixed(2) : 0,
      at: Date.now(),
    });
    const multi = redis.multi();
    multi.lpush(keys.gameFeed(o.gameSlug), entry);
    multi.ltrim(keys.gameFeed(o.gameSlug), 0, FEED_MAX - 1);
    multi.expire(keys.gameFeed(o.gameSlug), 60 * 60 * 24);
    await multi.exec();
  } catch (e) {
    console.error('[engagement] live feed push failed:', (e as Error).message);
  }
}

/** Push a big win onto the lobby ticker (threshold comes from settings). */
export async function pushBigWin(o: RoundOutcome): Promise<void> {
  try {
    const entry = JSON.stringify({
      user: maskUsername(o.displayName || `Player${o.userId.slice(-4)}`),
      game: o.gameSlug,
      payoutAmount: o.payoutAmount,
      at: Date.now(),
    });
    const multi = redis.multi();
    multi.lpush(keys.bigWins(), entry);
    multi.ltrim(keys.bigWins(), 0, FEED_MAX - 1);
    multi.expire(keys.bigWins(), 60 * 60 * 24);
    await multi.exec();
  } catch (e) {
    console.error('[engagement] big win push failed:', (e as Error).message);
  }
}

/**
 * Net loss for the day, used by responsiblePlayGuard's daily-loss limit.
 * The guard READ this key but nothing ever wrote it, so the limit never fired.
 */
async function trackDailyLoss(o: RoundOutcome): Promise<void> {
  const net = o.betAmount - o.payoutAmount;
  if (net === 0) return;
  try {
    const key = keys.dailyLoss(o.userId, dailyKey());
    await redis.incrbyfloat(key, net);
    await redis.expire(key, 60 * 60 * 48);
  } catch (e) {
    console.error('[engagement] daily loss tracking failed:', (e as Error).message);
  }
}

/** `lastActivityAt` powers the admin "active users (15 min)" tile. */
async function touchActivity(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { lastActivityAt: new Date() },
    });
  } catch (e) {
    console.error('[engagement] activity touch failed:', (e as Error).message);
  }
}

/**
 * Advance (or reset) the player's win streak and pay milestone bonuses.
 * Returns the bonus awarded, if any, so the caller can notify the player.
 */
export async function updateWinStreak(
  userId: string,
  isWin: boolean,
  milestones: Array<{ wins: number; bonus: number }>,
  /** H-10: the round this streak step belongs to — ledger reference ties the
   *  milestone payout to a UNIQUE round, so a retried round id can never
   *  double-pay, and a counter reset can never reuse the same reference. */
  roundId?: string
): Promise<{ streak: number; bonus: number } | null> {
  try {
    const existing = await prisma.winStreak.findUnique({ where: { userId } });
    if (!isWin) {
      if (existing && existing.currentStreak !== 0) {
        await prisma.winStreak.update({
          where: { userId },
          data: {
            currentStreak: 0,
            milestone5Paid: false,
            milestone10Paid: false,
            milestone25Paid: false,
          },
        });
      }
      return null;
    }

    // H-10: CAS increment — two concurrent settled wins must EACH move the
    // counter exactly once. The read-modify-write above lost increments under
    // concurrency. `compare old currentStreak → write +1` races safely through
    // updateMany; a lost race reads fresh and retries (bounded).
    let streak = 0;
    let row = existing ?? null;
    for (let attempt = 0; attempt < 3; attempt++) {
      row = await prisma.winStreak.findUnique({ where: { userId } });
      const next = (row?.currentStreak ?? 0) + 1;
      if (!row) {
        try {
          row = await prisma.winStreak.create({
            data: { userId, currentStreak: 1, lastWinAt: new Date() },
          });
          streak = 1;
          break;
        } catch {
          continue; // unique race: someone else just created it — re-read
        }
      }
      const updated = await prisma.winStreak.updateMany({
        where: { userId, currentStreak: row.currentStreak },
        data: { currentStreak: next, lastWinAt: new Date() },
      });
      if (updated.count === 1) {
        streak = next;
        break;
      }
      // lost the race — loop re-reads and retries
    }
    if (!streak || !row) return null;

    // Pay each milestone at most once per streak.
    const flag =
      streak >= 25
        ? 'milestone25Paid'
        : streak >= 10
          ? 'milestone10Paid'
          : streak >= 5
            ? 'milestone5Paid'
            : null;
    const milestone = milestones.find((m) => m.wins === streak);
    if (!flag || !milestone) return { streak, bonus: 0 };

    const { applyBalanceChange } = await import('./wallet');
    const Decimal = (await import('decimal.js')).default;
    await prisma.$transaction(async (tx) => {
      // H-10: the flag flip is CONDITIONAL — only the single request that
      // flips false→true pays. Two concurrent calls used to both observe the
      // unpaid flag and both credit.
      const claimed = await tx.winStreak.updateMany({
        where: { userId, [flag]: false },
        data: { [flag]: true },
      });
      if (claimed.count !== 1) return; // already awarded by a racing settle
      await applyBalanceChange(
        userId,
        'BONUS',
        new Decimal(milestone.bonus),
        'BONUS_WINSTREAK',
        {
          referenceType: 'win_streak',
          referenceId: roundId
            ? `streak:${userId}:${streak}:${roundId}`
            : `streak:${userId}:${streak}`,
          description: `${streak}-win streak bonus`,
        },
        tx
      );
    });
    // bonus reported only when actually paid — re-check the flag.
    const after = await prisma.winStreak.findUnique({ where: { userId } });
    const paid = after?.[flag as 'milestone5Paid'] === true;
    return { streak, bonus: paid ? milestone.bonus : 0 };
  } catch (e) {
    console.error('[engagement] win streak update failed:', (e as Error).message);
    return null;
  }
}
