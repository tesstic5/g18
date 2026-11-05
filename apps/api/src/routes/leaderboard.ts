// apps/api/src/routes/leaderboard.ts — daily/weekly/all-time (docs/20 §7 scoring = total wagered)
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { redis, logRedisIssue } from '../db/redis';
import { maskUsername } from '@casino/game-core/mask';

function periodKey(period: 'daily' | 'weekly'): string {
  const now = new Date();
  if (period === 'daily') return now.toISOString().slice(0, 10);
  const dow = (now.getUTCDay() + 6) % 7;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export async function leaderboardRoutes(app: FastifyInstance) {
  const handler = async (
    request: { user?: { id: string }; requestId?: string; query: { limit?: string } },
    period: 'daily' | 'weekly' | 'all_time'
  ) => {
    const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '20')));
    const key =
      period === 'all_time' ? 'lb:all_time' : `lb:${period}:${periodKey(period)}`;
    let results: string[] = [];
    try {
      results = (await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES')) as string[];
    } catch (e) {
      logRedisIssue('leaderboard', e);
    }
    // M-07: the board must survive a Redis flush / cold start. When the sorted
    // set is empty, rebuild it from Postgres (source of truth: settled,
    // non-demo rounds) and cache the rebuild back into Redis briefly so the
    // next requests don't re-scan.
    if (results.length === 0) {
      const since =
        period === 'daily'
          ? new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')
          : period === 'weekly'
            ? new Date(periodKey('weekly') + 'T00:00:00.000Z')
            : null;
      const grouped = await prisma.gameRound.groupBy({
        by: ['userId'],
        where: {
          demo: false,
          result: { not: 'PENDING' },
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        _sum: { betAmount: true },
        orderBy: { _sum: { betAmount: 'desc' } },
        take: limit,
      });
      results = grouped.flatMap((g) => [
        g.userId,
        Number(g._sum.betAmount ?? 0).toFixed(2),
      ]);
      if (grouped.length) {
        const args: (string | number)[] = [];
        for (const g of grouped)
          args.push(Number(g._sum.betAmount ?? 0).toFixed(2), g.userId);
        await redis
          .multi()
          .zadd(key, ...(args as [number | string, ...Array<number | string>]))
          .expire(key, 900) // rebuilt cache is short-lived; live zincrby keeps it warm
          .exec()
          .catch((e) => logRedisIssue('leaderboard-rebuild', e));
      }
    }
    // Resolve real (masked) display names — the old hardcoded `Pla***xx` was
    // a placeholder that made every row look identical.
    const ids: string[] = [];
    for (let i = 0; i < results.length; i += 2) ids.push(results[i]!);
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    const entries: Array<{
      rank: number;
      masked: string;
      totalWagered: number;
      isMe: boolean;
    }> = [];
    for (let i = 0; i < results.length; i += 2) {
      const id = results[i]!;
      entries.push({
        rank: i / 2 + 1,
        masked: maskUsername(nameById.get(id) || `Player${id.slice(-4)}`),
        totalWagered: parseFloat(results[i + 1]!),
        isMe: id === request.user?.id,
      });
    }
    return ok(entries, request.requestId!);
  };

  app.get('/daily', { preHandler: [authMiddleware] }, (req) =>
    handler(req as never, 'daily')
  );
  app.get('/weekly', { preHandler: [authMiddleware] }, (req) =>
    handler(req as never, 'weekly')
  );
  app.get('/all-time', { preHandler: [authMiddleware] }, (req) =>
    handler(req as never, 'all_time')
  );
}
