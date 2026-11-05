// apps/api/src/engine/StatisticsTracker.ts — rolling window, exact Redis mechanics.
// Canonical: docs/06 #10 + docs/20 absolute rule 10. Key: game:stats:{slug}.
// Update atomically with MULTI/EXEC after every round; rebuild from DB if missing.
import { prisma } from '../db/prisma';
import { redis, keys, logRedisIssue } from '../db/redis';

export interface RollingStats {
  totalWagered: number;
  totalPaidOut: number;
  wins: number;
  totalRounds: number;
}

export async function getRollingStats(gameSlug: string): Promise<RollingStats> {
  let raw: Record<string, string> | null = null;
  try {
    raw = await redis.hgetall(keys.gameStats(gameSlug));
  } catch (e) {
    // D-081: redis down → rebuild from DB instead of 500ing the bet
    logRedisIssue('stats', e);
    return rebuildFromDb(gameSlug);
  }
  if (!raw || Object.keys(raw).length === 0) {
    return rebuildFromDb(gameSlug);
  }
  return {
    totalWagered: Number(raw.totalWagered || 0),
    totalPaidOut: Number(raw.totalPaidOut || 0),
    wins: Number(raw.wins || 0),
    totalRounds: Number(raw.totalRounds || 0),
  };
}

/** Atomic update after every round (docs/20 §10: MULTI/EXEC). */
export async function recordRound(
  gameSlug: string,
  wagered: number,
  paidOut: number,
  isWin: boolean
): Promise<void> {
  // D-081: FAIL-OPEN — stats are observational; a Redis outage must never
  // fail the bet itself (the GameRound row is the source of truth).
  try {
    const multi = redis.multi();
    multi.hincrbyfloat(keys.gameStats(gameSlug), 'totalWagered', wagered);
    multi.hincrbyfloat(keys.gameStats(gameSlug), 'totalPaidOut', paidOut);
    if (isWin) multi.hincrby(keys.gameStats(gameSlug), 'wins', 1);
    multi.hincrby(keys.gameStats(gameSlug), 'totalRounds', 1);
    multi.expire(keys.gameStats(gameSlug), 60 * 60 * 24 * 7); // sliding 7d window
    await multi.exec();
  } catch (e) {
    logRedisIssue('stats', e);
  }
}

/** Rebuild from game_rounds if the Redis key is missing (docs/20 §10). */
export async function rebuildFromDb(gameSlug: string): Promise<RollingStats> {
  const agg = await prisma.gameRound.aggregate({
    where: {
      gameSlug,
      demo: false,
      result: { not: 'PENDING' }, // M-14: open sessions are not history
      createdAt: { gte: new Date(Date.now() - 1000 * 3600 * 24 * 7) },
    },
    _sum: { betAmount: true, payoutAmount: true },
    _count: true,
  });
  const wins = await prisma.gameRound.count({
    where: {
      gameSlug,
      demo: false,
      result: { in: ['WIN', 'CASHOUT'] },
      createdAt: { gte: new Date(Date.now() - 1000 * 3600 * 24 * 7) },
    },
  });
  const stats: RollingStats = {
    totalWagered: Number(agg._sum.betAmount || 0),
    totalPaidOut: Number(agg._sum.payoutAmount || 0),
    wins,
    totalRounds: agg._count,
  };
  // persist for next reads (best-effort)
  try {
    const multi = redis.multi();
    multi.hset(keys.gameStats(gameSlug), {
      totalWagered: stats.totalWagered,
      totalPaidOut: stats.totalPaidOut,
      wins: stats.wins,
      totalRounds: stats.totalRounds,
    } as never);
    multi.expire(keys.gameStats(gameSlug), 60 * 60 * 24 * 7);
    await multi.exec();
  } catch {
    /* best effort */
  }
  return stats;
}

export function currentRtp(stats: RollingStats): number {
  return stats.totalWagered > 0 ? (stats.totalPaidOut / stats.totalWagered) * 100 : 0;
}
export function currentWinRate(stats: RollingStats): number {
  return stats.totalRounds > 0 ? (stats.wins / stats.totalRounds) * 100 : 0;
}
