// apps/api/src/routes/reports.ts — streaming CSV report download (docs/20 §20).
// v5 (D-068): fixed raw SQL for Prisma's mixed-case table/column names
// (was `FROM GameRound`/`created_at` → Postgres "relation does not exist" 500s),
// added type=transactions ledger export.
//
// M-12: `type`/dates are allowlist-validated on BOTH endpoints (unknown types
// silently produced the transactions report; unvalidated dates crashed or
// poisoned the Content-Disposition filename).
// M-13: CSV cells are fully RFC-4180-escaped and spreadsheet-formula neu-
// tralized (a displayName of "=SUM(1,2)" must never execute in Excel).
//
// Metrics (must match /panel/dashboard/* and StatisticsTracker):
//   settled = GameRound WHERE demo=false AND result <> 'PENDING'
//   volume/wagered = SUM(betAmount)
//   payout/paid_out/won = SUM(payoutAmount)
//   GGR (house) = volume − payout   (PUSH payout=stake → GGR 0)
//   player net  = payout − volume
//   RTP         = payout / volume
//   win_rate    = (WIN + CASHOUT) / settled rounds
// Revenue is GameRound, never Transaction BET−WIN (REFUND/PUSH would inflate GGR).
// Day buckets: to_char("createdAt", 'YYYY-MM-DD') on TIMESTAMP(3) naive UTC.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma';
import { adminAuthMiddleware } from '../middleware';
import { ok, AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { toCSV } from '../lib/csv';
import { platformTimeZone } from '../lib/day-boundary';

const REPORT_TYPES = [
  'revenue',
  'games',
  'players',
  'deposits',
  'transactions',
] as const;
type ReportType = (typeof REPORT_TYPES)[number];

/** YYYY-MM-DD → [UTC day start, UTC day end]. Anything else → 422. */
function parseDayRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof fromRaw !== 'string' || !day.test(fromRaw)) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      '`from` must be YYYY-MM-DD'
    );
  }
  if (typeof toRaw !== 'string' || !day.test(toRaw)) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      '`to` must be YYYY-MM-DD'
    );
  }
  const from = new Date(fromRaw + 'T00:00:00.000Z');
  const to = new Date(toRaw + 'T23:59:59.999Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid date range');
  }
  // A "report" spanning more than a year is an export, not a report — cap it.
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'Date range must be ≤ 366 days'
    );
  }
  return { from, to };
}

function parseType(raw: unknown): ReportType {
  if (typeof raw === 'string' && (REPORT_TYPES as readonly string[]).includes(raw))
    return raw as ReportType;
  throw new AppError(
    ERROR_CODES.GEN_VALIDATION_ERROR,
    422,
    `type must be one of ${REPORT_TYPES.join(', ')}`
  );
}

async function runReport(
  type: ReportType,
  from: Date,
  to: Date
): Promise<Array<Record<string, unknown>>> {
  // Day buckets follow the PLATFORM day (see lib/day-boundary.ts): TIMESTAMP(3)
  // is naive UTC, so it is read as UTC and converted to the platform zone.
  const tz = platformTimeZone();
  if (type === 'revenue') {
    return prisma.$queryRaw`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') as date,
             COUNT(*)::int as rounds,
             COALESCE(SUM("betAmount"),0) as wagered,
             COALESCE(SUM("payoutAmount"),0) as paid_out,
             COALESCE(SUM("betAmount"),0) - COALESCE(SUM("payoutAmount"),0) as ggr,
             COUNT(DISTINCT "userId") as unique_players
      FROM "GameRound"
      WHERE "createdAt" BETWEEN ${from} AND ${to}
        AND demo = false AND "result" <> 'PENDING'
      GROUP BY 1 ORDER BY date ASC`;
  }
  if (type === 'games') {
    // Wins = WIN + CASHOUT (crash/mines/tower cashout is a win). RTP is
    // money returned, not ticket hit-rate — PUSH is neither a win nor GGR.
    return prisma.$queryRaw`
      SELECT "gameSlug", COUNT(*) as rounds, COALESCE(SUM("betAmount"),0) as wagered,
             COALESCE(SUM("payoutAmount"),0) as paid_out,
             COALESCE(SUM("betAmount"),0) - COALESCE(SUM("payoutAmount"),0) as ggr,
             COUNT(*) FILTER (WHERE "result" IN ('WIN','CASHOUT')) as wins,
             CASE WHEN COUNT(*) > 0
               THEN (COUNT(*) FILTER (WHERE "result" IN ('WIN','CASHOUT'))::float / COUNT(*)) * 100
               ELSE 0 END as win_rate,
             CASE WHEN COALESCE(SUM("betAmount"),0) > 0
               THEN (SUM("payoutAmount") / SUM("betAmount")) * 100
               ELSE 0 END as rtp
      FROM "GameRound" WHERE "createdAt" BETWEEN ${from} AND ${to} AND demo = false
        AND "result" <> 'PENDING'
      GROUP BY "gameSlug" ORDER BY wagered DESC`;
  }
  if (type === 'players') {
    return prisma.$queryRaw`
      SELECT u."id", u.phone, u."displayName", COUNT(gr.id) as rounds,
             COALESCE(SUM(gr."betAmount"),0) as wagered, COALESCE(SUM(gr."payoutAmount"),0) as won,
             COALESCE(SUM(gr."payoutAmount"),0) - COALESCE(SUM(gr."betAmount"),0) as net,
             COALESCE(SUM(gr."betAmount"),0) - COALESCE(SUM(gr."payoutAmount"),0) as ggr,
             COALESCE(MAX(gr."payoutAmount"),0) as biggest_win
      FROM "User" u JOIN "GameRound" gr ON gr."userId" = u."id"
      WHERE gr."createdAt" BETWEEN ${from} AND ${to} AND gr.demo = false
        AND gr."result" <> 'PENDING'
      GROUP BY u."id" ORDER BY wagered DESC LIMIT 100`;
  }
  if (type === 'deposits') {
    return prisma.$queryRaw`
      SELECT status, "paymentMethod", COUNT(*) as count, COALESCE(SUM(amount),0) as total
      FROM "Deposit" WHERE "createdAt" BETWEEN ${from} AND ${to}
      GROUP BY status, "paymentMethod" ORDER BY total DESC`;
  }
  return prisma.$queryRaw`
    SELECT to_char(t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI:SS') as date,
           COALESCE(u.phone, '') as user_phone, COALESCE(u."displayName", '') as user_name,
           t."type", t."walletType" as wallet, t."amount", t."balanceBefore", t."balanceAfter",
           COALESCE(t.description, '') as description, COALESCE(t."referenceType", '') as reference
    FROM "Transaction" t LEFT JOIN "User" u ON u."id" = t."userId"
    WHERE t."createdAt" BETWEEN ${from} AND ${to}
    ORDER BY t."createdAt" DESC LIMIT 5000`;
}

/** JSON-safe rows: COUNT(*) comes back as BigInt from pg; numbers → Number. */
function safeRows(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    )
  );
}

export async function reportRoutes(app: FastifyInstance) {
  // GET /api/v1/panel/reports/preview?type=&from=&to=
  app.get('/preview', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { type?: string; from?: string; to?: string };
    const type = parseType(q.type);
    const { from, to } = parseDayRange(q.from, q.to);
    const rows = safeRows(await runReport(type, from, to));
    return ok(rows, request.requestId!);
  });

  // GET /api/v1/panel/reports/download?type=&from=&to=&format=csv
  // NOTE (M-13): exports are capped (players 100, transactions 5000) — the cap
  // is deliberate and documented in the admin UI, NOT a silent truncation.
  app.get(
    '/download',
    { preHandler: [adminAuthMiddleware] },
    async (request, reply) => {
      const q = request.query as { type?: string; from?: string; to?: string };
      const type = parseType(q.type);
      const { from, to } = parseDayRange(q.from, q.to);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      // q.from/q.to are strictly ^\d{4}-\d{2}-\d{2}$ post-validation, so the
      // filename can carry no CRLF/header-injection payload.
      reply.header(
        'Content-Disposition',
        `attachment; filename="${type}-${q.from}-${q.to}.csv"`
      );
      const rows = await runReport(type, from, to);
      return reply.send(toCSV(rows));
    }
  );
}
