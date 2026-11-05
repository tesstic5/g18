// apps/api/src/routes/bonuses.ts — daily check-in, streaks, rakeback status (v4 + docs/19 §16)
import type { FastifyInstance } from 'fastify';
import { ok, AppError } from '../lib/core';
import { authMiddleware } from '../middleware';
import { startOfWeek } from '../lib/day-boundary';
import { prisma } from '../db/prisma';
import { applyBalanceChange } from '../services/wallet';
import { getSetting } from '../services/settings';
import { money } from '@casino/shared/utils/money';

export async function bonusRoutes(app: FastifyInstance) {
  // GET /bonuses/streak-status — calendar data + next bonus (D-067: homepage hero)
  app.get('/streak-status', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    const rows = await prisma.dailyCheckin.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 30,
    });
    const today = utcMidnight(new Date());
    const todayKey = today.toISOString().slice(0, 10);

    // LIVE streak, not the last one ever recorded.
    //
    // This used to be `rows[0]?.streakCount ?? 0` — the streak from the most
    // recent check-in whenever that was. After missing days it still showed the
    // old number and promised "day N+1", but POST /daily-checkin correctly
    // resets to day 1 when yesterday is missing. So the screen said day 2 and
    // the claim paid day 1. That is the "it goes back to day one" report.
    const streak = liveStreak(rows, today);
    const claimedToday = rows.some((r) => sameDay(r.date, today));
    // The streak is "broken" when there IS history but it no longer counts.
    const streakBroken = rows.length > 0 && streak === 0;

    const ladder =
      await getSetting<Array<{ day: number; bonus: number }>>('daily_checkin_ladder');
    const nextDay = claimedToday ? streak : streak + 1;
    const exact = ladder?.find((l) => l.day === nextDay);
    const nextBonus = exact
      ? Number(exact.bonus)
      : interpolate(ladder, nextDay).toNumber();

    // Eligibility: a bonus is a reward for playing, not a faucet. Without a
    // minimum balance, throwaway accounts can farm the ladder forever.
    const minBalance = money(
      (await getSetting<number>('daily_checkin_min_balance')) ?? 0
    );
    const wallet = await prisma.wallet.findFirst({ where: { userId } });
    const total = money(wallet?.realBalance ?? 0)
      .plus(wallet?.bonusBalance ?? 0)
      .plus(wallet?.giftedBalance ?? 0);
    const meetsBalance = total.gte(minBalance);

    const eligible = !claimedToday && meetsBalance;
    const reason = claimedToday
      ? 'Already claimed today — come back tomorrow'
      : !meetsBalance
        ? `Keep at least ${CURRENCY}${minBalance.toFixed(0)} in your wallet to claim the daily bonus`
        : null;

    return ok(
      {
        streak,
        claimedToday,
        streakBroken,
        nextDay,
        nextBonus,
        eligible,
        reason,
        minBalance: minBalance.toNumber(),
        balance: total.toNumber(),
        history: rows.map((r) => r.date.toISOString().slice(0, 10)),
        today: todayKey,
      },
      request.requestId!
    );
  });

  // POST /bonuses/daily-checkin — once per UTC day (docs/19 §16 ladder with interpolation)
  app.post('/daily-checkin', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    // DailyCheckin.date is @db.Date. Passing a timestamp with a time component
    // makes the (userId, date) unique lookup miss, which allowed a second claim
    // on the same day — normalize to UTC midnight.
    const today = utcMidnight(new Date());
    const todayKey = today.toISOString().slice(0, 10);

    const existing = await prisma.dailyCheckin.findUnique({
      where: { userId_date: { userId, date: today } },
    });
    if (existing)
      throw new AppError('BONUS_ALREADY_CLAIMED', 409, 'Already claimed today');

    // Minimum-balance gate (mirrored by /streak-status so the button can
    // explain itself rather than failing on tap).
    const minBalance = money(
      (await getSetting<number>('daily_checkin_min_balance')) ?? 0
    );
    if (minBalance.gt(0)) {
      const wallet = await prisma.wallet.findFirst({ where: { userId } });
      const total = money(wallet?.realBalance ?? 0)
        .plus(wallet?.bonusBalance ?? 0)
        .plus(wallet?.giftedBalance ?? 0);
      if (total.lt(minBalance)) {
        throw new AppError(
          'BONUS_MIN_BALANCE',
          422,
          `Keep at least ${CURRENCY}${minBalance.toFixed(0)} in your wallet to claim the daily bonus`
        );
      }
    }

    // streak: 0 if missed yesterday, else previous + 1
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const prev = await prisma.dailyCheckin.findUnique({
      where: { userId_date: { userId, date: yesterday } },
    });
    const streak = (prev?.streakCount ?? 0) + 1;

    const ladder =
      await getSetting<Array<{ day: number; bonus: number }>>('daily_checkin_ladder');
    const exact = ladder?.find((l) => l.day === streak);
    const bonus = exact ? money(exact.bonus) : interpolate(ladder, streak);

    const newBalance = await prisma.$transaction(async (tx) => {
      const checkin = await tx.dailyCheckin.create({
        data: {
          userId,
          date: today,
          streakCount: streak,
          bonusAmount: bonus.toFixed(2),
        },
      });
      // Was a bare wallet.update: no version bump, no ledger row — check-in
      // bonuses were invisible in transaction history and reconciliation.
      return applyBalanceChange(
        userId,
        'BONUS',
        bonus,
        'BONUS_CHECKIN',
        {
          referenceType: 'bonus',
          referenceId: checkin.id,
          description: `Daily check-in day ${streak}`,
        },
        tx
      );
    });

    // Push the new snapshot so every open tab (header chip, wallet page)
    // updates without waiting for a second GET that the client used to swallow.
    try {
      const io = (
        globalThis as {
          __io?: { to: (r: string) => { emit: (e: string, p: unknown) => void } };
        }
      ).__io;
      io?.to(`user:${userId}`).emit('balance:update', newBalance);
    } catch {
      /* socket is best-effort */
    }

    return ok(
      { streak, bonus: bonus.toFixed(2), day: todayKey, newBalance },
      request.requestId!
    );
  });

  // GET /bonuses/rakeback-status
  app.get('/rakeback-status', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    const weekStart = startOfWeek();
    const record = await prisma.rakebackRecord.findUnique({
      where: { userId_weekStart: { userId, weekStart } },
    });
    return ok(
      {
        weekStart: weekStart.toISOString().slice(0, 10),
        paid: !!record?.paidAt,
        amount: record?.rakeback.toString() ?? '0',
      },
      request.requestId!
    );
  });
}

const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '\u20a8';

/** Same calendar day, comparing @db.Date values at UTC midnight. */
function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * The streak that is actually still running.
 * Only counts if the newest check-in was today or yesterday; otherwise the run
 * has lapsed and the next claim starts again at day 1 — which is exactly what
 * POST /daily-checkin does.
 */
export function liveStreak(
  rows: Array<{ date: Date; streakCount: number }>,
  today: Date
): number {
  const newest = rows[0];
  if (!newest) return 0;
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (sameDay(newest.date, today) || sameDay(newest.date, yesterday))
    return newest.streakCount;
  return 0;
}

/** UTC midnight for @db.Date columns. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Interpolate between ladder milestones (docs/19 §16).
 * Defensive: an empty/missing ladder used to throw a TypeError here → 500 on
 * every check-in. Settings validation now prevents an empty ladder, but this
 * must not be the thing that breaks if one slips through.
 */
function interpolate(
  ladder: Array<{ day: number; bonus: number }> | null | undefined,
  day: number
): ReturnType<typeof money> {
  if (!Array.isArray(ladder) || ladder.length === 0) return money(0);
  const sorted = [...ladder].sort((a, b) => a.day - b.day);
  if (day <= sorted[0]!.day) return money(sorted[0]!.bonus);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (day <= next.day) {
      const t = (day - prev.day) / (next.day - prev.day);
      return money(prev.bonus).plus(money(next.bonus).minus(prev.bonus).mul(t));
    }
  }
  return money(sorted[sorted.length - 1]!.bonus);
}
