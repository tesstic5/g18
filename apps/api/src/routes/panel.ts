// apps/api/src/routes/panel.ts — admin panel: auth, dashboard, users, queues, managers,
// settings, audit, broadcasts, support, legal, payment accounts, impersonation, fraud.
// v5 (D-068): professional console — richer dashboard (trends/top players/activity feed),
// user management (stats + transactions + balance adjust w/ reason + notification),
// full transaction ledger, structured payment-account CRUD, real logout, ws-token.
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { ok, AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { adminAuthMiddleware, rateLimitFactory, requireStepUp } from '../middleware';
import { writeAudit, writeAuditTx } from '../lib/audit';
import { getJwtPrivateKey, getJwtPublicKey } from '../lib/jwt-keys';
import {
  JWT_ISSUER_ADMIN,
  JWT_ISSUER_ADMIN_WS,
  JWT_ROLE_ADMIN,
  JWT_ROLE_ADMIN_WS,
} from '../lib/jwt-claims';
import { notifyUser } from '../services/notify';
import { exportJson, restoreJson, type BackupFile } from '../services/backup';
import { applyBalanceChange } from '../services/wallet';
import { revokeAllSessions } from '../services/auth';
import { prisma } from '../db/prisma';
import { redis, keys } from '../db/redis';
import { getNumericSetting, getSettings } from '../services/settings';
import { maskPhone } from '@casino/game-core/mask';
import { decryptJson } from '../lib/crypto-utils';
import {
  buildPlatformArchive,
  describePlatformBackup,
  restorePlatformArchive,
} from '../services/backupArchive';
import { rm } from 'node:fs/promises';
import { addDays, dayKey, platformTimeZone, startOfDay } from '../lib/day-boundary';
import { csvCell } from '../lib/csv';
import { mintCsrf, ensureCsrf, clearCsrfCookie, ADMIN_CSRF_MAX_AGE } from '../lib/csrf';
import {
  abortUpload,
  appendChunkStream,
  archiveCeiling,
  CHUNK_REQUEST_SLACK_BYTES,
  createUpload,
  finishUpload,
  serverChunkBytes,
  sweepStaleUploads,
} from '../lib/chunkedUpload';
import { getRestoreJob, startRestoreJob } from '../lib/backupJobs';
import { getUserRiskProfile, raiseFraudSignal } from '../services/fraud';
import { freezeActive, freezeMessage } from '../services/recovery';
import { dualControlStage } from '../services/securityPolicy';
import {
  lastMessagesByConvo,
  previewOf,
  unreadCount,
  waitMsFromLast,
  loadPlayerContext,
  serializeMessage,
} from '../services/supportDesk';
import { adminPermissions } from '../middleware';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { maybeRewardReferral } from '../services/referral';
import {
  validateSmtpPatch,
  prepareSmtpPatch,
  maskSmtpSettings,
  smtpFromSettings,
  recipientsFromSettings,
  SMTP_PASSWORD_KEY,
  SMTP_STRING_KEYS,
  SMTP_BOOLEAN_KEYS,
  emailBackupEnabled,
} from '../services/smtpSettings';
import { sendTestEmail } from '../services/backupDelivery';
import { cookieSecureFor, insecureSecureCookieWarning } from '../lib/cookies';

const PAGE = 25;

// A JSON backup is uploaded as ONE request body, and the API's global limit is
// 10 MiB (server.ts: bodyLimit) — plenty for normal traffic, far too small for
// a real backup bundle. The restore route opts into this ceiling instead; it is
// super-admin-only + CSRF + confirm-token guarded, so it is not a public
// surface. Override with BACKUP_MAX_JSON_BYTES when a bundle is larger still
// (e.g. 1073741824 for 1 GiB). The reverse proxy must allow the same size —
// nginx ships client_max_body_size 512m for /api/v1/.
// An archive carries every uploaded image too, so its ceiling is separate (and
// larger) than the JSON bundle's.
const BACKUP_MAX_ARCHIVE_BYTES =
  Number(process.env.BACKUP_MAX_ARCHIVE_BYTES) || 2 * 1024 * 1024 * 1024;

const BACKUP_MAX_JSON_BYTES =
  Number(process.env.BACKUP_MAX_JSON_BYTES) || 256 * 1024 * 1024;
const WALLET_FIELDS = {
  real: 'realBalance',
  bonus: 'bonusBalance',
  gifted: 'giftedBalance',
} as const;
const WALLET_ENUM = { real: 'REAL', bonus: 'BONUS', gifted: 'GIFTED' } as const;
const PAY_ACCOUNT_TYPES = ['mobile_wallet', 'bank'];

// M-12: finance/status filters previously went straight into Prisma enum
// fields via `as never` — any unlisted value 500'd. Allowlist or 422.
function enumOr422<T extends string>(
  val: unknown,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'string' && (allowed as readonly string[]).includes(val))
    return val as T;
  throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, `Invalid ${label}`);
}
const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
const USER_STATUS_FILTERS = ['ACTIVE', 'SUSPENDED', 'CLOSED', 'SELF_EXCLUDED'] as const;
const DEPOSIT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;
// Review decisions: the only statuses an admin PATCH may set on a deposit/withdrawal.
const REVIEW_STATUSES = ['APPROVED', 'REJECTED', 'COMPLETED'] as const;
const WITHDRAWAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
  'CANCELLED',
] as const;
const TX_TYPES = [
  'BET',
  'WIN',
  'REFUND',
  'DEPOSIT',
  'WITHDRAWAL',
  'BONUS_CHECKIN',
  'BONUS_SIGNUP',
  'BONUS_REFERRAL',
  'BONUS_WINSTREAK',
  'BONUS_RAKEBACK',
  'GIFT_SENT',
  'GIFT_RECEIVED',
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
] as const;
const WALLET_TYPE_FILTERS = ['REAL', 'BONUS', 'GIFTED', 'LOCKED'] as const;

export async function panelRoutes(app: FastifyInstance) {
  // ── AUTH ───────────────────────────────────────────────────────────────
  app.post(
    '/auth/login',
    { preHandler: [rateLimitFactory('login', (r) => r.ip)] },
    async (request, reply) => {
      const body = request.body as { username?: string; password?: string };
      const admin = await prisma.adminUser.findUnique({
        where: { username: body.username || '' },
      });
      // D-103: a missing/corrupt passwordHash must be "invalid credentials", NOT
      // an internal 500 (bcrypt.compare throws on a bad hash).
      if (
        !admin ||
        !admin.passwordHash ||
        !(await bcrypt.compare(body.password || '', admin.passwordHash))
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_INVALID_CREDENTIALS,
          401,
          'Invalid credentials'
        );
      }
      await prisma.adminUser.update({
        where: { id: admin.id },
        // lastActiveAt matters as much as lastLoginAt here: the admin-auth
        // middleware ends a session that has been idle longer than
        // `admin_idle_timeout_minutes` (default 60) and ONLY refreshes the
        // stamp once a request has already passed that check. Signing in is
        // activity by definition, so logging in without stamping it left a
        // freshly authenticated admin locked out on the next request
        // (401 AUTH_002 “Panel session ended after N minutes of inactivity”) —
        // and permanently so, because the stamp is never touched again.
        // Seen in the field on a VPS whose database was restored from a local
        // dump: lastActiveAt came from the dump, was hours old, and every
        // login bounced straight back to the login page while the password was
        // perfectly correct.
        data: { lastLoginAt: new Date(), lastActiveAt: new Date() },
      });
      const token = signAdmin(admin.id, admin.sessionVersion);
      // A `Secure` cookie over plain http is dropped by the browser without a
      // word, and the panel then loops: "Welcome back, admin" → login page.
      // Log it loudly so the operator sees the cause in the api logs.
      if (insecureSecureCookieWarning(request)) {
        request.log.warn(
          'admin session cookie is Secure but this request arrived over http — ' +
            'browsers will discard it (set COOKIE_SECURE=false for a local run, ' +
            'or serve the panel over https)'
        );
      }
      reply.setCookie('admin_token', token, {
        httpOnly: true,
        secure: cookieSecureFor(request),
        sameSite: 'strict',
        maxAge: 8 * 3600,
        // Scope to /api/v1, NOT just /api/v1/panel: browsers never send a
        // cookie outside its Path, and the deposit-proof viewer lives at
        // /api/v1/deposits/proof/* — with the old path the admin's "View ↗"
        // link arrived with NO cookie and always 401'd ("admin can't see
        // uploaded proof images"). Player auth uses Bearer headers, never
        // this cookie, so the wider same-origin scope grants nothing new.
        path: '/api/v1',
      });
      // CSRF double-submit. Lax + maxAge matching admin_token (8h) + token in
      // JSON: document.cookie cannot read a cookie set on the API host when
      // the panel is served from a sibling origin (the Accept CSRF_INVALID bug).
      const csrfToken = mintCsrf(reply, ADMIN_CSRF_MAX_AGE, request);
      return ok(
        {
          token,
          csrfToken,
          admin: {
            id: admin.id,
            username: admin.username,
            isSuperAdmin: admin.isSuperAdmin,
          },
        },
        request.requestId!
      );
    }
  );
  app.get('/auth/me', { preHandler: [adminAuthMiddleware] }, (request, reply) => {
    const csrfToken = ensureCsrf(request, reply, ADMIN_CSRF_MAX_AGE);
    return ok(
      {
        id: request.admin!.id,
        username: request.admin!.username,
        isSuperAdmin: request.admin!.isSuperAdmin,
        hiddenFromAdmins: request.admin!.hiddenFromAdmins,
        // Permission flags so the panel can hide sections this manager cannot
        // reach. A super-admin short-circuits every check server-side, so it
        // is reported as holding all six — otherwise the nav would hide
        // sections the server would happily serve. This response is UI
        // convenience only; adminAuthMiddleware remains the authoritative gate.
        permissions: adminPermissions(request.admin!),
        csrfToken,
      },
      request.requestId!
    );
  });

  // POST /panel/auth/logout — clears the admin cookie (was 404 before D-068)
  app.post('/auth/logout', async (request, reply) => {
    // Bump the session version first, so the cookie that was just stolen (or
    // copied off an unlocked laptop) is dead everywhere, not only in this
    // browser. Clearing a cookie cannot reach the copy someone else holds.
    try {
      const raw =
        (request.cookies as Record<string, string | undefined> | undefined)?.admin_token ??
        '';
      if (raw) {
        const payload = jwt.verify(raw, getJwtPublicKey(), {
          algorithms: ['RS256'],
          issuer: JWT_ISSUER_ADMIN,
          ignoreExpiration: true,
        }) as { sub?: string };
        if (payload.sub) {
          await prisma.adminUser.update({
            where: { id: payload.sub },
            data: { sessionVersion: { increment: 1 } },
          });
        }
      }
    } catch {
      /* logging out must always succeed, even with a stale/corrupt cookie */
    }
    reply.clearCookie('admin_token', { path: '/api/v1' });
    // Also clear the legacy /api/v1/panel-scoped cookie from older sessions —
    // browsers key cookies by (name, path), so the pre-1.3.1 copy would
    // otherwise survive logout for up to 8h.
    reply.clearCookie('admin_token', { path: '/api/v1/panel' });
    clearCsrfCookie(reply);
    return ok({ loggedOut: true }, request.requestId!);
  });

  // GET /panel/auth/ws-token — short-lived admin JWT for the dashboard live feed socket
  app.get('/auth/ws-token', { preHandler: [adminAuthMiddleware] }, (request) => {
    const token = jwt.sign(
      { sub: request.admin!.id, role: JWT_ROLE_ADMIN_WS },
      getJwtPrivateKey(),
      { algorithm: 'RS256', expiresIn: '15m', issuer: JWT_ISSUER_ADMIN_WS }
    );
    return ok({ token, expiresIn: 15 * 60 }, request.requestId!);
  });

  // ── DASHBOARD ──────────────────────────────────────────────────────────
  app.get(
    '/dashboard/stats',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const now = new Date();
      const today = startOfDay(now);
      const weekStart = addDays(today, -6);
      const gt = (d: Date) => ({ gte: d });
      const [
        totalUsers,
        betsToday,
        volWeek,
        volAll,
        depToday,
        wdToday,
        activeUsers,
        newSignups,
        pendDep,
        pendWd,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.gameRound.aggregate({
          where: { createdAt: gt(today), demo: false, result: { not: 'PENDING' } },
          _count: true,
          _sum: { betAmount: true, payoutAmount: true },
        }),
        prisma.gameRound.aggregate({
          where: { createdAt: gt(weekStart), demo: false, result: { not: 'PENDING' } },
          _sum: { betAmount: true, payoutAmount: true },
        }),
        prisma.gameRound.aggregate({
          where: { demo: false, result: { not: 'PENDING' } },
          _sum: { betAmount: true, payoutAmount: true },
        }),
        prisma.deposit.aggregate({
          where: { createdAt: gt(today), status: { in: ['APPROVED', 'COMPLETED'] } },
          _count: true,
          _sum: { amount: true },
        }),
        prisma.withdrawal.aggregate({
          where: { createdAt: gt(today), status: { in: ['APPROVED', 'COMPLETED'] } },
          _count: true,
          _sum: { amount: true },
        }),
        prisma.user.count({
          where: {
            status: 'ACTIVE',
            lastActivityAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
          },
        }),
        prisma.user.count({ where: { createdAt: gt(today) } }),
        prisma.deposit.aggregate({
          where: { status: 'PENDING' },
          _count: true,
          _sum: { amount: true },
        }),
        prisma.withdrawal.aggregate({
          where: { status: 'PENDING' },
          _count: true,
          _sum: { amount: true },
        }),
      ]);
      const sum = (
        a: { _sum: { betAmount?: unknown; payoutAmount?: unknown; amount?: unknown } },
        k: 'betAmount' | 'payoutAmount' | 'amount'
      ) => Number(a._sum[k] || 0);
      return ok(
        {
          totals: {
            users: totalUsers,
            volume: sum(volAll, 'betAmount'),
            ggr: sum(volAll, 'betAmount') - sum(volAll, 'payoutAmount'),
          },
          week: {
            volume: sum(volWeek, 'betAmount'),
            ggr: sum(volWeek, 'betAmount') - sum(volWeek, 'payoutAmount'),
          },
          today: {
            bets: betsToday._count,
            volume: sum(betsToday, 'betAmount'),
            payout: sum(betsToday, 'payoutAmount'),
            ggr: sum(betsToday, 'betAmount') - sum(betsToday, 'payoutAmount'),
            deposits: { count: depToday._count, amount: sum(depToday, 'amount') },
            withdrawals: { count: wdToday._count, amount: sum(wdToday, 'amount') },
            signups: newSignups,
          },
          activeUsers,
          pendingDeposits: { count: pendDep._count, amount: sum(pendDep, 'amount') },
          pendingWithdrawals: { count: pendWd._count, amount: sum(pendWd, 'amount') },
        },
        request.requestId!
      );
    }
  );

  // GET /dashboard/revenue-trend?days=14 — daily volume/payout/ggr buckets (missing days zero-filled)
  app.get(
    '/dashboard/revenue-trend',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const days = Math.min(
        31,
        Math.max(7, parseInt((request.query as { days?: string }).days || '14'))
      );
      const from = addDays(startOfDay(), -(days - 1));
      // Settled real-money only. Day buckets follow the PLATFORM day: TIMESTAMP(3)
      // stores naive UTC, so it is read as UTC and converted to the platform zone.
      const tz = platformTimeZone();
      const rows = await prisma.$queryRaw<
        Array<{ date: string; rounds: bigint; volume: Decimal; payout: Decimal }>
      >`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') as date,
             COUNT(*)::int as rounds,
             COALESCE(SUM("betAmount"),0) as volume, COALESCE(SUM("payoutAmount"),0) as payout
      FROM "GameRound"
      WHERE "createdAt" >= ${from} AND demo = false AND "result" <> 'PENDING'
      GROUP BY 1 ORDER BY date ASC`;
      const byDate = new Map(rows.map((r) => [r.date, r]));
      const out: Array<{
        date: string;
        rounds: number;
        volume: number;
        payout: number;
        ggr: number;
      }> = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(from);
        d.setUTCDate(d.getUTCDate() + i);
        const key = dayKey(d);
        const r = byDate.get(key);
        out.push({
          date: key,
          rounds: r ? Number(r.rounds) : 0,
          volume: r ? Number(r.volume) : 0,
          payout: r ? Number(r.payout) : 0,
          ggr: r ? Number(r.volume) - Number(r.payout) : 0,
        });
      }
      return ok(out, request.requestId!);
    }
  );

  // GET /dashboard/game-performance?days=7 — per-game rounds/volume/payout/rtp
  app.get(
    '/dashboard/game-performance',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const days = Math.min(
        31,
        Math.max(1, parseInt((request.query as { days?: string }).days || '7'))
      );
      const from = addDays(startOfDay(), -(days - 1));
      const rows = await prisma.$queryRaw<
        Array<{
          slug: string;
          name: string | null;
          rounds: bigint;
          volume: Decimal;
          payout: Decimal;
        }>
      >`
      SELECT gr."gameSlug" as slug, gc."displayName" as name,
             COUNT(*)::int as rounds, COALESCE(SUM(gr."betAmount"),0) as volume,
             COALESCE(SUM(gr."payoutAmount"),0) as payout
      FROM "GameRound" gr LEFT JOIN "GameConfig" gc ON gc.slug = gr."gameSlug"
      WHERE gr."createdAt" >= ${from} AND gr.demo = false AND gr."result" <> 'PENDING'
      GROUP BY gr."gameSlug", gc."displayName" ORDER BY volume DESC`;
      return ok(
        rows.map((r) => ({
          slug: r.slug,
          name: r.name ?? r.slug,
          rounds: Number(r.rounds),
          volume: Number(r.volume),
          payout: Number(r.payout),
          ggr: Number(r.volume) - Number(r.payout),
          rtp:
            Number(r.volume) > 0
              ? Math.round((Number(r.payout) / Number(r.volume)) * 1000) / 10
              : null,
        })),
        request.requestId!
      );
    }
  );

  // GET /dashboard/top-players?days=7&limit=10 — biggest bettors (masked)
  app.get(
    '/dashboard/top-players',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const q = request.query as { days?: string; limit?: string };
      const days = Math.min(90, Math.max(1, parseInt(q.days || '7')));
      const limit = Math.min(50, Math.max(5, parseInt(q.limit || '10')));
      const from = addDays(startOfDay(), -(days - 1));
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          phone: string;
          displayName: string | null;
          rounds: bigint;
          wagered: Decimal;
          won: Decimal;
        }>
      >`
      SELECT u."id", u.phone, u."displayName",
             COUNT(*)::int as rounds, COALESCE(SUM(gr."betAmount"),0) as wagered,
             COALESCE(SUM(gr."payoutAmount"),0) as won
      FROM "GameRound" gr JOIN "User" u ON u."id" = gr."userId"
      WHERE gr."createdAt" >= ${from} AND gr.demo = false AND gr."result" <> 'PENDING'
      GROUP BY u."id" ORDER BY wagered DESC LIMIT ${limit}`;
      return ok(
        rows.map((r) => ({
          id: r.id,
          phone: maskPhone(r.phone),
          displayName: r.displayName,
          rounds: Number(r.rounds),
          wagered: Number(r.wagered),
          won: Number(r.won),
          // Player P&L (won − wagered). House GGR is the negation.
          net: Number(r.won) - Number(r.wagered),
        })),
        request.requestId!
      );
    }
  );

  // GET /dashboard/recent-activity?limit=30 — mixed feed (bets/signups/deposits/withdrawals)
  app.get(
    '/dashboard/recent-activity',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const limit = Math.min(
        60,
        Math.max(10, parseInt((request.query as { limit?: string }).limit || '30'))
      );
      const [bets, signups, deposits, withdrawals] = await Promise.all([
        prisma.gameRound.findMany({
          where: { demo: false, result: { not: 'PENDING' } },
          orderBy: { createdAt: 'desc' },
          take: 15,
          select: {
            id: true,
            createdAt: true,
            gameSlug: true,
            betAmount: true,
            payoutAmount: true,
            result: true,
            user: { select: { phone: true, displayName: true } },
          },
        }),
        prisma.user.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, phone: true, displayName: true, createdAt: true },
        }),
        prisma.deposit.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            id: true,
            createdAt: true,
            amount: true,
            status: true,
            paymentMethod: true,
            user: { select: { phone: true, displayName: true } },
          },
        }),
        prisma.withdrawal.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            id: true,
            createdAt: true,
            amount: true,
            status: true,
            user: { select: { phone: true, displayName: true } },
          },
        }),
      ]);
      const who = (u: { phone: string; displayName: string | null }) =>
        u.displayName || maskPhone(u.phone);
      const feed = [
        ...bets.map((b) => ({
          kind: 'bet' as const,
          id: b.id,
          at: b.createdAt.getTime(),
          user: who(b.user),
          game: b.gameSlug,
          amount: Number(b.betAmount),
          result: b.result,
          payout: Number(b.payoutAmount),
        })),
        ...signups.map((u) => ({
          kind: 'signup' as const,
          id: u.id,
          at: u.createdAt.getTime(),
          user: u.displayName || maskPhone(u.phone),
        })),
        ...deposits.map((d) => ({
          kind: 'deposit' as const,
          id: d.id,
          at: d.createdAt.getTime(),
          user: who(d.user),
          amount: Number(d.amount),
          status: d.status,
          method: d.paymentMethod,
        })),
        ...withdrawals.map((w) => ({
          kind: 'withdrawal' as const,
          id: w.id,
          at: w.createdAt.getTime(),
          user: who(w.user),
          amount: Number(w.amount),
          status: w.status,
        })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
      return ok(feed, request.requestId!);
    }
  );

  // ── USERS ──────────────────────────────────────────────────────────────
  app.get('/users', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { search?: string; status?: string; page?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const where = {
      ...(q.search
        ? {
            OR: [
              { phone: { contains: q.search } },
              { displayName: { contains: q.search } },
            ],
          }
        : {}),
      ...(enumOr422(q.status, USER_STATUS_FILTERS, 'status')
        ? { status: enumOr422(q.status, USER_STATUS_FILTERS, 'status') as never }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: {
          id: true,
          phone: true,
          displayName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          lastActivityAt: true,
          wallet: {
            select: { realBalance: true, bonusBalance: true, giftedBalance: true },
          },
          _count: {
            select: {
              gameRounds: true,
              deposits: true,
              withdrawals: true,
              referrals: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);
    return ok(
      {
        data: rows.map((u) => ({
          id: u.id,
          phone: maskPhone(u.phone),
          displayName: u.displayName,
          status: u.status,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt,
          lastActivityAt: u.lastActivityAt,
          real: u.wallet?.realBalance.toString() ?? '0',
          bonus: u.wallet?.bonusBalance.toString() ?? '0',
          gifted: u.wallet?.giftedBalance.toString() ?? '0',
          rounds: u._count.gameRounds,
          deposits: u._count.deposits,
          withdrawals: u._count.withdrawals,
          referrals: u._count.referrals,
        })),
        total,
      },
      request.requestId!
    );
  });

  app.get('/users/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    // H-05: explicit DTO allow-list — the raw Prisma row leaks passwordHash,
    // fingerprintHash, full PII and internal responsible-play internals to any
    // manager with permUsers. Authentication material may never be serialized.
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        displayName: true,
        avatarUrl: true,
        language: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        referredById: true,
        referralCode: true,
        onboardingDone: true,
        dailyLossLimit: true,
        dailyDepositLimit: true,
        sessionReminderMin: true,
        selfExcludedUntil: true,
        kycStatus: true,
        fingerprintHash: true,
        lastLoginIp: true,
        lastLoginCountry: true,
        lastActivityAt: true,
        wallet: {
          select: {
            realBalance: true,
            bonusBalance: true,
            giftedBalance: true,
            lockedBalance: true,
          },
        },
      },
    });
    if (!user) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'User not found');
    const risk = await getUserRiskProfile(id);
    // H-05b: audit PII access to the detail view — reading a player's full
    // profile is a privacy event a regulator will ask about.
    const admin = request.admin as { id?: string; username?: string } | undefined;
    if (admin?.id) {
      void writeAudit({
        adminId: admin.id,
        action: 'user.pii_view',
        targetType: 'User',
        targetId: id,
        afterState: { viewer: admin.username ?? null },
      }).catch(() => {
        /* audit best-effort — read must not fail on log failure */
      });
    }
    return ok({ ...user, risk }, request.requestId!);
  });

  // GET /users/:id/stats — lifetime betting/deposit/withdrawal/referral totals
  app.get(
    '/users/:id/stats',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const [rounds, deposits, withdrawals, checkins, referrals, transactions] =
        await Promise.all([
          prisma.gameRound.aggregate({
            where: { userId: id, demo: false, result: { not: 'PENDING' } },
            _count: true,
            _sum: { betAmount: true, payoutAmount: true },
          }),
          prisma.deposit.aggregate({
            where: { userId: id, status: { in: ['APPROVED', 'COMPLETED'] } },
            _count: true,
            _sum: { amount: true },
          }),
          prisma.withdrawal.aggregate({
            where: { userId: id, status: { in: ['APPROVED', 'COMPLETED'] } },
            _count: true,
            _sum: { amount: true, fee: true },
          }),
          prisma.dailyCheckin.count({ where: { userId: id } }),
          prisma.user.count({ where: { referredById: id } }),
          prisma.transaction.count({ where: { userId: id } }),
        ]);
      return ok(
        {
          rounds: {
            count: rounds._count,
            volume: Number(rounds._sum.betAmount || 0),
            payout: Number(rounds._sum.payoutAmount || 0),
            // House GGR (volume − payout). Player drawer labels this “Net to house”.
            // Dashboard top-players `net` is the opposite (player P&L).
            net:
              Number(rounds._sum.betAmount || 0) -
              Number(rounds._sum.payoutAmount || 0),
          },
          deposits: {
            count: deposits._count,
            amount: Number(deposits._sum.amount || 0),
          },
          withdrawals: {
            count: withdrawals._count,
            amount: Number(withdrawals._sum.amount || 0),
            fee: Number(withdrawals._sum.fee || 0),
          },
          checkins,
          referrals,
          transactions,
        },
        request.requestId!
      );
    }
  );

  // GET /users/:id/transactions?page=1 — player ledger
  app.get(
    '/users/:id/transactions',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const page = Math.max(
        1,
        parseInt((request.query as { page?: string }).page || '1')
      );
      const [rows, total] = await Promise.all([
        prisma.transaction.findMany({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * PAGE,
          take: PAGE,
        }),
        prisma.transaction.count({ where: { userId: id } }),
      ]);
      return ok({ data: rows, total, page }, request.requestId!);
    }
  );

  app.patch('/users/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; note?: string; kycStatus?: string };
    const KYC_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
    const nextKyc = enumOr422(body.kycStatus, KYC_STATUSES, 'kycStatus');
    // M-12: status must be a real UserStatus — the old `as never` passed any
    // string to Prisma and 500'd (or worse, wrote a nonsense status).
    const nextStatus = enumOr422(body.status, USER_STATUSES, 'status');
    if (!nextStatus && !nextKyc)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'status or kycStatus is required'
      );
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      beforeState: { status: before.status, kycStatus: before.kycStatus },
      afterState: body,
      ip: request.ip,
    });
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(nextStatus ? { status: nextStatus as never } : {}),
        ...(nextKyc ? { kycStatus: nextKyc } : {}),
      },
    });
    // Kill active sessions immediately. Without this a suspended user keeps a
    // valid refresh token and can mint fresh access tokens for up to 7 days.
    if (body.status === 'SUSPENDED' || body.status === 'CLOSED') {
      const killed = await revokeAllSessions(
        id,
        `admin_${String(body.status).toLowerCase()}`
      );
      request.log.info({ userId: id, killed }, 'revoked sessions after status change');
    }
    if (body.status === 'SUSPENDED') {
      void notifyUser(
        id,
        'Account suspended',
        `Your account has been ${body.note ? `suspended. Reason: ${body.note}` : 'suspended'}. Contact support if this is a mistake.`,
        'account',
        '/support'
      );
    }
    return ok(
      { id: updated.id, status: updated.status, kycStatus: updated.kycStatus },
      request.requestId!
    );
  });

  // POST /users/:id/fund — admin credit/debit with reason, ledger record + player notification
  app.post(
    '/users/:id/fund',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        walletType: 'real' | 'bonus' | 'gifted';
        amount: number;
        reason?: string;
        /** Set by the SECOND admin when clearing a parked credit. */
        confirmDualControl?: boolean;
      };
      const field = WALLET_FIELDS[body.walletType];
      if (!field)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'walletType must be real, bonus or gifted'
        );
      const amt = Number(body.amount);
      if (!Number.isFinite(amt) || amt === 0)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Amount must be a non-zero number'
        );
      if (Math.abs(amt) > 10_000_000)
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Amount too large');
      const reason = (body.reason || '').trim().slice(0, 200);

      // ── DUAL CONTROL ON WALLET CREDITS (security hardening) ────────────
      // Handing a player money is as sensitive as paying one out: single-admin
      // credits are how an insider pays a colluding account. Above the
      // threshold a credit/debit is PARKED as a request and must be cleared by
      // a second admin; below it, behaviour is unchanged.
      const creditThreshold = await getNumericSetting(
        'admin_credit_dual_control_threshold',
        25000,
        { min: 0 }
      );
      const needsSignature =
        creditThreshold > 0 &&
        Math.abs(amt) >= creditThreshold &&
        body.confirmDualControl !== true;
      if (needsSignature) {
        const pendingRequest = await prisma.walletAdjustment.create({
          data: {
            userId: id,
            walletType: body.walletType,
            amount: new Decimal(amt).toFixed(2),
            reason,
            requestedBy: request.admin!.id,
          },
        });
        await writeAudit({
          adminId: request.admin!.id,
          action: 'user.fund.requested',
          targetType: 'user',
          targetId: id,
          afterState: { walletType: body.walletType, amount: amt, reason },
          ip: request.ip,
        });
        emitAdmin('wallet-adjustment-requested', {
          id: shortId(pendingRequest.id),
          userId: shortId(id),
          amount: amt,
          at: Date.now(),
        });
        return ok(
          {
            pendingApproval: true,
            requestId: pendingRequest.id,
            message:
              'Amount is at or above the dual-control threshold — a second admin must approve it before the balance moves. It is listed under Panel → Monitoring → pending adjustments.',
          },
          request.requestId!
        );
      }
      const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: id } });
      await writeAudit({
        adminId: request.admin!.id,
        action: amt > 0 ? 'user.credit' : 'user.debit',
        targetType: 'user',
        targetId: id,
        beforeState: { [body.walletType]: (before[field] as Decimal).toString() },
        afterState: { walletType: body.walletType, amount: amt, reason },
        ip: request.ip,
      });
      const updated = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: id } });
        const beforeBal = wallet[field] as Decimal;
        if (beforeBal.plus(amt).lt(0))
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Balance cannot go below zero'
          );
        // Route through the locking+ledger helper so `Wallet.version` is bumped
        // and the correct ADMIN_CREDIT/ADMIN_DEBIT type is recorded (was always
        // ADMIN_CREDIT, even for debits).
        await applyBalanceChange(
          id,
          WALLET_ENUM[body.walletType],
          new Decimal(amt),
          amt > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
          {
            referenceType: 'admin',
            referenceId: request.admin!.id,
            description: `${amt > 0 ? 'Admin credit' : 'Admin debit'}${reason ? `: ${reason}` : ''}`,
          },
          tx
        );
        const updatedWallet = await tx.wallet.findUniqueOrThrow({
          where: { userId: id },
        });
        return { wallet: updatedWallet };
      });
      const label = body.walletType === 'real' ? 'cash' : body.walletType;
      void notifyUser(
        id,
        amt > 0 ? 'Balance top-up ✅' : 'Balance adjusted',
        amt > 0
          ? `₨${amt.toLocaleString()} has been added to your ${label} balance${reason ? ` (${reason})` : ''}.`
          : `₨${Math.abs(amt).toLocaleString()} was deducted from your ${label} balance${reason ? ` (${reason})` : ''}.`,
        'wallet',
        '/wallet'
      );
      return ok(
        {
          real: updated.wallet.realBalance.toString(),
          bonus: updated.wallet.bonusBalance.toString(),
          gifted: updated.wallet.giftedBalance.toString(),
        },
        request.requestId!
      );
    }
  );

  // ── TRANSACTION LEDGER (D-068) — every money movement, filterable, with CSV export via /reports/download?type=transactions
  app.get('/transactions', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as {
      type?: string;
      walletType?: string;
      search?: string;
      from?: string;
      to?: string;
      page?: string;
    };
    const page = Math.max(1, parseInt(q.page || '1'));
    const where = {
      ...(enumOr422(q.type, TX_TYPES, 'type')
        ? { type: enumOr422(q.type, TX_TYPES, 'type') as never }
        : {}),
      ...(enumOr422(q.walletType, WALLET_TYPE_FILTERS, 'walletType')
        ? {
            walletType: enumOr422(
              q.walletType,
              WALLET_TYPE_FILTERS,
              'walletType'
            ) as never,
          }
        : {}),
      ...(q.search
        ? {
            user: {
              OR: [
                { phone: { contains: q.search } },
                { displayName: { contains: q.search } },
              ],
            },
          }
        : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to + 'T23:59:59') } : {}),
            },
          }
        : {}),
    };
    const [rows, total, sums] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
      prisma.transaction.count({ where }),
      prisma.transaction.aggregate({ where, _sum: { amount: true } }),
    ]);
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((t) => t.userId))] } },
      select: { id: true, phone: true, displayName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return ok(
      {
        data: rows.map((t) => {
          const u = userMap.get(t.userId);
          return {
            ...t,
            amount: t.amount.toString(),
            balanceBefore: t.balanceBefore.toString(),
            balanceAfter: t.balanceAfter.toString(),
            userPhone: u ? maskPhone(u.phone) : null,
            userName: u?.displayName ?? null,
          };
        }),
        total,
        sum: Number(sums._sum.amount || 0),
      },
      request.requestId!
    );
  });

  // ── DEPOSIT QUEUE ──────────────────────────────────────────────────────
  /**
   * Short-lived, key-bound signed URL for a deposit proof. The admin's
   * "View ↗" is a plain <a target="_blank"> — it cannot carry an
   * Authorization header, and the shared admin cookie already broke this
   * click once via Path scoping (v1.3.1). A 10-minute RS256 token in the
   * query string works in every cookie/proxy/SameSite/TLS setup. Minted ONLY
   * in this permission-gated list; the proof route re-checks scope + key.
   */
  const signProofToken = (objectKey: string): string =>
    jwt.sign({ scope: 'deposit-proof', k: objectKey }, getJwtPrivateKey(), {
      algorithm: 'RS256',
      expiresIn: '10m',
      issuer: JWT_ISSUER_ADMIN,
    });

  app.get('/deposits', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const where = {
      status: (enumOr422(q.status, DEPOSIT_STATUSES, 'status') ?? 'PENDING') as never,
    };
    const [rows, total, sums] = await Promise.all([
      prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { user: { select: { phone: true, displayName: true } } },
      }),
      prisma.deposit.count({ where }),
      prisma.deposit.aggregate({ where, _sum: { amount: true } }),
    ]);
    return ok(
      {
        data: rows.map((d) => ({
          ...d,
          amount: d.amount.toString(),
          userPhone: d.user ? maskPhone(d.user.phone) : null,
          userName: d.user?.displayName ?? null,
          // Click-ready proof URL: works without any cookie/header state.
          proofUrl: d.proofObjectKey
            ? `/api/v1/deposits/proof/${d.proofObjectKey}?pt=${encodeURIComponent(signProofToken(d.proofObjectKey))}`
            : null,
        })),
        total,
        sum: Number(sums._sum.amount || 0),
      },
      request.requestId!
    );
  });

  app.patch('/deposits/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status: 'APPROVED' | 'REJECTED' | 'COMPLETED';
      notes?: string;
      gatewayId?: string;
    };
    // Allow-list the decision BEFORE any DB work: an unlisted status used to
    // reach the claim transaction and 500 on `body.status.toLowerCase()`.
    const nextStatus = enumOr422(body.status, REVIEW_STATUSES, 'status');
    if (!nextStatus)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'status is required');
    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id } });

    if (deposit.paymentMethod === 'PAYFAST')
      throw new AppError('PAYFAST_MANAGED', 409, 'PayFast deposits must be settled by the gateway or reconciled separately');
    const updated = await prisma.$transaction(async (tx) => {
      // Exactly one reviewer may claim a pending deposit. A read-then-update race
      // allowed two concurrent approvals to both credit the wallet.
      const claimed = await tx.deposit.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: nextStatus,
          notes: body.notes,
          gatewayId: body.gatewayId,
          reviewedBy: request.admin!.id,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1)
        throw new AppError('GAME_007', 409, 'Deposit already reviewed');
      // H-19: audit INSIDE the claim transaction — only a review that
      // actually wins the claim ever records an audit row.
      await writeAuditTx(tx, {
        adminId: request.admin!.id,
        action: `deposit.${nextStatus.toLowerCase()}`,
        targetType: 'deposit',
        targetId: id,
        beforeState: { status: deposit.status },
        afterState: body,
        ip: request.ip,
      });
      const d = await tx.deposit.findUniqueOrThrow({ where: { id } });
      if (nextStatus === 'APPROVED' || nextStatus === 'COMPLETED') {
        // Exactly-once credit: the PENDING claim above is the primary guard.
        // Skip if a DEPOSIT ledger row already exists for this deposit (a
        // prior Accept that the UI treated as CSRF_INVALID, or a replay).
        const already = await tx.transaction.findMany({
          where: { referenceType: 'deposit', referenceId: d.id, type: 'DEPOSIT' },
          select: { walletType: true },
        });
        const credited = new Set(already.map((t) => t.walletType));
        const realCredit = new Decimal((d.packageCredits ?? d.amount).toString());
        if (!credited.has('REAL')) {
          await applyBalanceChange(
            d.userId,
            'REAL',
            realCredit,
            'DEPOSIT',
            {
              referenceType: 'deposit',
              referenceId: d.id,
              description: `Deposit ${d.referenceNumber}`,
            },
            tx
          );
        }
        // Package promo goes to the BONUS wallet so it has to be wagered
        // rather than withdrawn straight back out. The amount is the one
        // snapshotted when the player paid, so later edits to the package
        // cannot change what an already-paid deposit is worth.
        const promo = new Decimal((d.packageBonus ?? 0).toString());
        if (promo.gt(0) && !credited.has('BONUS')) {
          await applyBalanceChange(
            d.userId,
            'BONUS',
            promo,
            'DEPOSIT',
            {
              referenceType: 'deposit',
              referenceId: d.id,
              description: `Package bonus on ${d.referenceNumber}`,
            },
            tx
          );
        }

        // REFERRAL REWARD — fires on this player's FIRST approved deposit.
        //
        // Deliberately inside this transaction: the PENDING claim above is the
        // only way an approval can happen, so this runs exactly once per
        // approved deposit, and maybeRewardReferral's own conditional UPDATE
        // makes it once per PLAYER (a second deposit updates 0 rows and skips).
        // It never throws — a referral problem must not roll back a deposit the
        // admin just approved.
        await maybeRewardReferral(tx, d.userId);
      }
      return d;
    });
    void notifyUser(
      updated.userId,
      nextStatus === 'APPROVED' || nextStatus === 'COMPLETED'
        ? 'Deposit approved ✅'
        : 'Deposit rejected',
      nextStatus === 'APPROVED' || nextStatus === 'COMPLETED'
        ? `Your deposit of ${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${updated.amount.toString()} has been credited.`
        : `Your deposit of ${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${updated.amount.toString()} was rejected. ${body.notes ? 'Reason: ' + body.notes : ''}`,
      'deposit',
      '/wallet'
    );
    // D-083: dedicated event so an open deposit page can flip to "approved"
    // instantly (the generic notification:new also fires via notifyUser).
    const io = (globalThis as { __io?: import('socket.io').Server }).__io;
    io?.to(`user:${updated.userId}`).emit('deposit:status', {
      id: updated.id,
      status: updated.status,
      amount: Number(updated.amount),
      notes: body.notes ?? null,
      at: Date.now(),
    });
    return ok({ id: updated.id, status: updated.status }, request.requestId!);
  });

  // ── WITHDRAWAL QUEUE ───────────────────────────────────────────────────
  app.get('/withdrawals', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const where = {
      status: (enumOr422(q.status, WITHDRAWAL_STATUSES, 'status') ??
        'PENDING') as never,
    };
    const [rows, total, sums] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          payoutAccount: true,
          user: { select: { phone: true, displayName: true } },
        },
      }),
      prisma.withdrawal.count({ where }),
      prisma.withdrawal.aggregate({ where, _sum: { amount: true, fee: true } }),
    ]);
    return ok(
      {
        data: rows.map((w) => {
          let accountDetails: Record<string, string> = {};
          try {
            accountDetails = decryptJson<Record<string, string>>(
              w.payoutAccount.accountDetails
            );
          } catch {
            accountDetails = { error: 'Unable to decrypt this payout account' };
          }
          return {
            ...w,
            amount: w.amount.toString(),
            fee: w.fee.toString(),
            netAmount: w.netAmount.toString(),
            payoutAccount: { ...w.payoutAccount, accountDetails },
            userPhone: w.user ? maskPhone(w.user.phone) : null,
            userName: w.user?.displayName ?? null,
          };
        }),
        total,
        sum: Number(sums._sum.amount || 0),
        feeSum: Number(sums._sum.fee || 0),
      },
      request.requestId!
    );
  });

  app.patch(
    '/withdrawals/:id',
    // STEP-UP: this is the route that pays money out — but the guard runs
    // INSIDE the handler, after the request is validated and the withdrawal is
    // known to exist (see the call below). A preHandler would answer 403 for a
    // malformed body that used to be 422, and for an id that does not exist
    // (404); both contracts predate this feature and the integration suite
    // pins them.
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        status: 'APPROVED' | 'REJECTED' | 'COMPLETED';
        notes?: string;
        gatewayId?: string;
        /** Super-admin escape hatch for a payout that must go out anyway.
         *  Audited and raised as a fraud signal — see the recovery console. */
        overrideFreeze?: boolean;
      };
      // Same guard as deposit review: reject unlisted statuses with 422
      // instead of 500ing inside the claim transaction.
      const nextStatus = enumOr422(body.status, REVIEW_STATUSES, 'status');
      if (!nextStatus)
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'status is required');
      const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });

      // STEP-UP gate, after validation (422) and existence (404) so those
      // answers never degrade into a 403. Nothing below moves money.
      await requireStepUp(request);

      // ── DUAL CONTROL (security hardening) ──────────────────────────────
      // A payout at or above the threshold needs TWO different admins. The
      // first PATCH records the first approval and changes nothing else; the
      // second (from a different admin) is the one that releases the money.
      // Rejection is exempt on purpose — refusing a payout is always safe and
      // must never wait on a second signature.
      if (nextStatus === 'APPROVED' && w.dualControlRequired) {
        const stage = dualControlStage({
          amount: Number(w.amount),
          threshold: 1, // already snapshotted on the row: this is a two-person row
          firstApproverId: w.firstApprovedBy,
          approverId: request.admin!.id,
        });
        if (stage.stage === 'rejected')
          throw new AppError(ERROR_CODES.FIN_DUAL_CONTROL_REQUIRED, 403, stage.reason);
        if (stage.stage === 'awaiting-first') {
          await writeAudit({
            adminId: request.admin!.id,
            action: 'withdrawal.first_approval',
            targetType: 'withdrawal',
            targetId: id,
            beforeState: { status: w.status, firstApprovedBy: null },
            afterState: { status: w.status, firstApprovedBy: request.admin!.id },
            ip: request.ip,
          });
          const staged = await prisma.withdrawal.update({
            where: { id },
            data: {
              firstApprovedBy: request.admin!.id,
              firstApprovedAt: new Date(),
              notes: body.notes ?? w.notes,
            },
          });
          const amount = staged.amount.toString();
          void notifyUser(
            staged.userId,
            'Withdrawal under review',
            `Your withdrawal of ₨${staged.netAmount.toString()} needs a second approval before it is processed. This is normal for larger payouts.`,
            'withdrawal',
            '/wallet'
          );
          emitAdmin('withdrawal-first-approval', { id, at: Date.now() });
          return ok(
            {
              id,
              status: staged.status,
              needsSecondApproval: true,
              message:
                'First approval recorded. A different admin must approve this payout before it is processed.',
              amount,
            },
            request.requestId!
          );
        }
      }

      // RECOVERY FREEZE (routes/recovery.ts): money does not leave an account
      // while a recovery is in flight. Reject/refund is unaffected — taking a
      // payout BACK is always safe. Pushing one through needs a super-admin,
      // an explicit override flag, an audit row and a fraud signal.
      if (nextStatus !== 'REJECTED') {
        const payer = await prisma.user.findUniqueOrThrow({
          where: { id: w.userId },
          select: { withdrawalFrozenUntil: true },
        });
        const until = payer.withdrawalFrozenUntil;
        if (until && freezeActive(until)) {
          if (!body.overrideFreeze)
            throw new AppError(
              ERROR_CODES.FIN_RECOVERY_FREEZE,
              409,
              `Withdrawal on hold — ${freezeMessage(until)}`
            );
          if (!request.admin!.isSuperAdmin)
            throw new AppError(
              ERROR_CODES.AUTH_TOKEN_INVALID,
              403,
              'Only a super-admin can override a recovery freeze'
            );
          await writeAudit({
            adminId: request.admin!.id,
            action: 'recovery.freeze.override',
            targetType: 'withdrawal',
            targetId: id,
            beforeState: { freezeUntil: until, status: w.status },
            afterState: { pushedThrough: true, nextStatus },
            ip: request.ip,
          });
          await raiseFraudSignal(
            w.userId,
            'RECOVERY_FREEZE_OVERRIDE',
            'high',
            {
              notes: 'Payout pushed through an active recovery freeze',
              withdrawalId: id,
              adminId: request.admin!.id,
              freezeUntil: new Date(until).toISOString(),
            },
            { dedupe: false }
          );
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const expectedStatus:
          'PENDING' | 'APPROVED' | { in: Array<'PENDING' | 'APPROVED'> } =
          nextStatus === 'APPROVED'
            ? 'PENDING'
            : nextStatus === 'COMPLETED'
              ? 'APPROVED'
              : { in: ['PENDING', 'APPROVED'] };
        const claimed = await tx.withdrawal.updateMany({
          where: { id, status: expectedStatus },
          data: {
            status: nextStatus,
            notes: body.notes,
            gatewayId: body.gatewayId,
            reviewedBy: request.admin!.id,
            reviewedAt: new Date(),
            // Dual-control rows record WHO released the money separately from
            // the reviewer, so the two signatures are both recoverable later.
            ...(nextStatus === 'APPROVED' && w.dualControlRequired
              ? { secondApprovedBy: request.admin!.id, secondApprovedAt: new Date() }
              : {}),
          },
        });
        if (claimed.count !== 1)
          throw new AppError('GAME_007', 409, 'Withdrawal already processed');
        // H-19: audit INSIDE the claim transaction (post-claim).
        await writeAuditTx(tx, {
          adminId: request.admin!.id,
          action: `withdrawal.${nextStatus.toLowerCase()}`,
          targetType: 'withdrawal',
          targetId: id,
          beforeState: { status: w.status },
          afterState: body,
          ip: request.ip,
        });
        if (nextStatus === 'REJECTED') {
          // Refund the GROSS amount that was held at request time (the fee is
          // only realised on a completed payout), via the locking+ledger helper.
          await applyBalanceChange(
            w.userId,
            'REAL',
            new Decimal(w.amount.toString()),
            'REFUND',
            {
              referenceType: 'withdrawal',
              referenceId: w.id,
              description: 'Withdrawal rejected',
            },
            tx
          );
        }
        return tx.withdrawal.findUniqueOrThrow({ where: { id } });
      });
      void notifyUser(
        updated.userId,
        nextStatus === 'APPROVED'
          ? 'Withdrawal approved'
          : nextStatus === 'COMPLETED'
            ? 'Withdrawal completed ✅'
            : 'Withdrawal rejected',
        nextStatus === 'REJECTED'
          ? `Your withdrawal of ₨${updated.netAmount.toString()} was rejected. ${body.notes ? 'Reason: ' + body.notes : 'Funds have been returned to your balance.'}`
          : `Your withdrawal of ₨${updated.netAmount.toString()} is ${nextStatus === 'APPROVED' ? 'approved and being processed' : 'complete'}.`,
        'withdrawal',
        '/wallet'
      );
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      io?.to(`user:${updated.userId}`).emit('withdrawal:status', {
        id: updated.id,
        status: updated.status,
        notes: body.notes ?? null,
        at: Date.now(),
      });
      return ok({ id: updated.id, status: updated.status }, request.requestId!);
    }
  );

  // ── BACKUP & RESTORE (D-062) — admin-only ───────────────────────────────
  app.get(
    '/backup/export-json',
    { preHandler: [adminAuthMiddleware] },
    async (request, reply) => {
      // A full export contains every user + ledger row — super-admin only.
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can export a full backup'
        );
      }
      const bundle = await exportJson();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      reply.header('Content-Type', 'application/json');
      reply.header(
        'Content-Disposition',
        `attachment; filename="casino-backup-${stamp}.json"`
      );
      return reply.send(JSON.stringify(bundle, null, 2));
    }
  );

  // GET /panel/backup/export-csv?table=users|transactions — spreadsheet export
  app.get(
    '/backup/export-csv',
    { preHandler: [adminAuthMiddleware] },
    async (request, reply) => {
      const q = request.query as { table?: string };
      const table =
        q.table === 'transactions'
          ? 'transaction'
          : q.table === 'users'
            ? 'user'
            : null;
      if (!table)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'table must be users or transactions'
        );
      const rows =
        table === 'transaction'
          ? await prisma.transaction.findMany({
              orderBy: { createdAt: 'desc' },
              take: 5000,
            })
          : await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 5000 });
      const allowed =
        table === 'transaction'
          ? [
              'id',
              'userId',
              'type',
              'walletType',
              'amount',
              'balanceBefore',
              'balanceAfter',
              'description',
              'referenceType',
              'createdAt',
            ]
          : ['id', 'phone', 'displayName', 'status', 'createdAt', 'lastLoginAt'];
      const csv = [
        allowed.join(','),
        ...rows.map((r) =>
          allowed.map((k) => csvCell((r as Record<string, unknown>)[k])).join(',')
        ),
      ].join('\n');
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${table}s-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      return reply.send(csv);
    }
  );

  // GET /panel/backup/archive-info — what a backup would contain, WITHOUT
  // building it. The panel shows these numbers so "Download" is an informed
  // click, not a leap.
  app.get(
    '/backup/archive-info',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can download a full backup'
        );
      }
      return ok(await describePlatformBackup(), request.requestId!);
    }
  );

  // GET /panel/backup/download — ONE file: the database AND every uploaded image.
  // Streamed, so the browser writes it straight to disk: it never sits in the
  // tab's memory the way a fetch→blob download would.
  app.get(
    '/backup/download',
    { preHandler: [adminAuthMiddleware] },
    async (request, reply) => {
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can download a full backup'
        );
      }
      const { stream, manifest } = await buildPlatformArchive();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      reply.header('Content-Type', 'application/gzip');
      reply.header(
        'Content-Disposition',
        `attachment; filename="casino-platform-${stamp}.tar.gz"`
      );
      reply.header('Cache-Control', 'no-store');
      // Downloading every row and image the platform holds is worth a record.
      await writeAudit({
        adminId: request.admin!.id,
        action: 'backup.download_archive',
        targetType: 'system',
        afterState: {
          objects: manifest.objects.count,
          objectBytes: manifest.objects.bytes,
          databaseBytes: manifest.parts['database.json']?.bytes ?? 0,
          ...(manifest.objects.error ? { objectsError: manifest.objects.error } : {}),
        },
        ip: request.ip,
      });
      return reply.send(stream);
    }
  );

  // POST /panel/backup/restore-archive/preflight — prove the password BEFORE the
  // upload starts. The restore route can only check step-up once the body has
  // arrived, and being told "re-authenticate" after pushing 2 GB at the server
  // is exactly the sort of thing that makes a panel feel hostile.
  app.post(
    '/backup/restore-archive/preflight',
    { preHandler: [adminAuthMiddleware, requireStepUp] },
    async (request) => {
      if (!request.admin!.isSuperAdmin)
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can restore a backup'
        );
      return ok({ ready: true }, request.requestId!);
    }
  );

  // ── CHUNKED UPLOAD + BACKGROUND RESTORE ─────────────────────────────
  //
  // The single-shot route below stays (scripts use it, and it is the shape a
  // small archive is happy with), but the panel now uploads in chunks and lets
  // the restore run as a job. Reason, in one line: a multi-minute request that
  // carries a file AND waits for the whole restore is cut by the proxies in
  // front of the API — Traefik's default 60s read timeout is a deadline for the
  // entire request including the body — and the operator was left staring at
  // "Upload failed (HTTP 408)" at 99% with no idea whether the data had been
  // restored. Short chunk requests cannot be cut that way, and the restore is
  // polled instead of awaited.

  // POST /panel/backup/upload/init — reserve an upload id and a chunk size.
  app.post('/backup/upload/init', { onRequest: [adminAuthMiddleware] }, async (request) => {
    if (!request.admin!.isSuperAdmin) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        403,
        'Only super admin can restore a backup'
      );
    }
    const body = request.body as { size?: number } | undefined;
    const started = await createUpload(Number(body?.size));
    return ok(
      {
        uploadId: started.uploadId,
        chunkSize: started.chunkSize,
        received: started.received,
        ceiling: started.ceiling,
      },
      request.requestId!
    );
  });

  // POST /panel/backup/upload/chunk?uploadId=…&offset=… — one slice of the file.
  // Content-Type: application/octet-stream. The body is streamed straight onto
  // the end of the partial file; nothing is buffered in memory.
  app.post(
    '/backup/upload/chunk',
    {
      onRequest: [adminAuthMiddleware],
      bodyLimit: Math.min(archiveCeiling(), serverChunkBytes() + CHUNK_REQUEST_SLACK_BYTES),
    },
    async (request) => {
      if (!request.admin!.isSuperAdmin) {
        (request.body as { resume?: () => void } | undefined)?.resume?.();
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can restore a backup'
        );
      }
      const query = request.query as { uploadId?: string; offset?: string } | undefined;
      const offset = Number(query?.offset);
      const payload = request.body as unknown;
      // Fastify hands us the raw stream. If we refuse the request we must drain
      // it, or the client waits for a reply that never comes.
      const drain = (): void => {
        (payload as { resume?: () => void } | undefined)?.resume?.();
      };
      if (!payload || typeof payload !== 'object' || !('pipe' in (payload as object))) {
        drain();
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Send the chunk as the request body with Content-Type: application/octet-stream'
        );
      }
      const result = await appendChunkStream(
        String(query?.uploadId ?? ''),
        offset,
        payload as Parameters<typeof appendChunkStream>[2]
      );
      return ok({ received: result.received }, request.requestId!);
    }
  );

  // POST /panel/backup/upload/finish — the last byte is in; hand back the path
  // the restore reads. The bytes are NOT trusted: the archive restore verifies
  // the manifest and every checksum before it touches the database.
  app.post('/backup/upload/finish', { onRequest: [adminAuthMiddleware] }, async (request) => {
    if (!request.admin!.isSuperAdmin) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        403,
        'Only super admin can restore a backup'
      );
    }
    const body = request.body as { uploadId?: string } | undefined;
    const done = await finishUpload(String(body?.uploadId ?? ''));
    return ok({ tempPath: done.tempPath, bytes: done.bytes }, request.requestId!);
  });

  // POST /panel/backup/upload/abort — the admin cancelled; drop the partial file
  // instead of leaving gigabytes in /tmp (a sweep also runs on every init).
  app.post('/backup/upload/abort', { onRequest: [adminAuthMiddleware] }, async (request) => {
    const body = request.body as { uploadId?: string } | undefined;
    await abortUpload(String(body?.uploadId ?? ''));
    return ok({ aborted: true }, request.requestId!);
  });

  // POST /panel/backup/restore/start — begin the restore as a background job.
  // requireStepUp (a fresh password) is enforced HERE, right before anything is
  // written, and the response comes back immediately with a job to watch.
  app.post(
    '/backup/restore/start',
    { onRequest: [adminAuthMiddleware, requireStepUp] },
    async (request) => {
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can restore a backup'
        );
      }
      const body = request.body as { tempPath?: string } | undefined;
      if (!body?.tempPath) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'No uploaded file to restore — upload the backup again.'
        );
      }
      void sweepStaleUploads(); // keep /tmp tidy on the way in, too
      const started = startRestoreJob({
        tempPath: body.tempPath,
        startedBy: request.admin!.username,
      });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'backup.restore_archive',
        targetType: 'platform',
        targetId: 'all',
        afterState: { jobId: started.jobId, source: 'chunked-upload' },
      });
      return ok(started, request.requestId!);
    }
  );

  // GET /panel/backup/restore/status?jobId=…&jobToken=… — progress of that job.
  // Authorised by the per-job token rather than the admin session: the restore
  // replaces AdminUser with the backup's rows, which can sign the operator out
  // mid-restore, and they still need to see the outcome.
  app.get('/backup/restore/status', async (request) => {
    const query = request.query as { jobId?: string; jobToken?: string } | undefined;
    const job = await getRestoreJob(String(query?.jobId ?? ''), String(query?.jobToken ?? ''));
    if (!job) {
      throw new AppError(
        ERROR_CODES.GEN_NOT_FOUND,
        404,
        'That restore job is no longer available — reload this page to see the current state.'
      );
    }
    return ok(job, request.requestId!);
  });

  // POST /panel/backup/restore-archive — restore that same one file.
  // The body is the .tar.gz itself (Content-Type: application/gzip); server.ts
  // streams it to a temp file and hands us the path.
  //
  // NOTE the hooks below are onRequest, not preHandler: Fastify parses the body
  // BEFORE preHandler runs, so a preHandler check would only fire after the
  // whole archive had been uploaded. onRequest runs first — an unauthorised or
  // wrong-role upload is refused before a single byte reaches the disk.
  app.post(
    '/backup/restore-archive',
    { onRequest: [adminAuthMiddleware, requireStepUp], bodyLimit: BACKUP_MAX_ARCHIVE_BYTES },
    async (request) => {
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can restore a backup'
        );
      }
      const body = request.body as { tempPath?: string } | undefined;
      if (!body?.tempPath) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Send the backup file as the request body with Content-Type: application/gzip'
        );
      }
      try {
        const result = await restorePlatformArchive(body.tempPath);
        // Audit AFTER — a restore wipes AdminAuditLog along with everything else.
        await writeAudit({
          adminId: request.admin!.id,
          action: 'backup.restore_archive',
          targetType: 'system',
          afterState: {
            tables: Object.keys(result.tables).length,
            objectsRestored: result.objects.restored,
            objectsFailed: result.objects.failed,
          },
          ip: request.ip,
        });
        return ok(result, request.requestId!);
      } finally {
        // Never leave a full copy of the platform sitting in /tmp.
        await rm(body.tempPath, { force: true }).catch(() => undefined);
      }
    }
  );

  // POST /panel/backup/restore-json — full restore with confirm token
  // bodyLimit: raised per-route (see BACKUP_MAX_JSON_BYTES). Keep this route's
  // ceiling separate from the global one so a huge upload can only ever be
  // attempted here, by an authenticated super admin.
  app.post(
    '/backup/restore-json',
    // STEP-UP: a restore wipes and rewrites every table. Require the admin to
    // have proved their password in the last few minutes, so a hijacked panel
    // session (or an unlocked laptop) cannot destroy the platform.
    { preHandler: [adminAuthMiddleware, requireStepUp], bodyLimit: BACKUP_MAX_JSON_BYTES },
    async (request) => {
      // Restore WIPES every table. Super-admin only — a manager must never be
      // able to destroy (or, via a crafted bundle, rewrite) the whole platform.
      if (!request.admin!.isSuperAdmin) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'Only super admin can restore a backup'
        );
      }
      const body = request.body as { confirm?: string; data?: BackupFile };
      if (body.confirm !== 'RESTORE')
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'confirm=RESTORE required'
        );
      if (!body.data)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Backup bundle is required'
        );
      const counts = await restoreJson(body.data!);
      // H-11: audit AFTER the restore — the restore wipes AdminAuditLog along
      // with everything else, so the pre-restore row (the old behaviour) was
      // deleted by the very action it recorded.
      await writeAudit({
        adminId: request.admin!.id,
        action: 'backup.restore',
        targetType: 'system',
        afterState: { backupVersion: body.data?.version, restoredCounts: counts },
        ip: request.ip,
      });
      return ok(counts, request.requestId!);
    }
  );

  // ── MANAGERS ─────────────────────────────────────────────────────────
  // Any authenticated admin may view the list (admin can manage other admins/
  // managers but never super admins — enforced in PATCH). Super can see all.
  app.get('/managers', { preHandler: [adminAuthMiddleware] }, async (request) => {
    // A non-super admin must never see that a super admin exists: super-admin
    // rows are filtered out entirely (not just masked) for them. Super admins
    // see everyone except super admins who chose to hide themselves.
    const viewer = request.admin!;
    const rows = await prisma.adminUser.findMany({
      where:
        viewer.isSuperAdmin
          ? { OR: [{ isSuperAdmin: false }, { hiddenFromAdmins: false }, { id: viewer.id }] }
          : { isSuperAdmin: false },
      select: {
        id: true,
        username: true,
        isSuperAdmin: true,
        hiddenFromAdmins: true,
        lastLoginAt: true,
        createdAt: true,
        permFinancial: true,
        permUsers: true,
        permReporting: true,
        permChat: true,
        permGames: true,
        permSettings: true,
      },
    });
    return ok(rows, request.requestId!);
  });

  // PATCH /panel/managers/me — a super admin toggles whether they are hidden
  // from other admins' managers list. Non-super admins cannot use this.
  app.patch('/managers/me', { preHandler: [adminAuthMiddleware] }, async (request) => {
    if (!request.admin!.isSuperAdmin)
      throw new AppError(ERROR_CODES.PANEL_FORBIDDEN, 403, 'Super-admin only');
    const body = z
      .object({ hiddenFromAdmins: z.boolean() })
      .parse(request.body);
    await prisma.adminUser.update({
      where: { id: request.admin!.id },
      data: { hiddenFromAdmins: body.hiddenFromAdmins },
    });
    return ok({ hiddenFromAdmins: body.hiddenFromAdmins }, request.requestId!);
  });
  app.post('/managers', { preHandler: [adminAuthMiddleware] }, async (request) => {
    // Any admin may create a manager, but only super admin may create a super admin.
    // The handler below validates target super-admin promotion.
    const body = request.body as {
      username: string;
      password: string;
      isSuperAdmin?: boolean;
      permissions: {
        financial: boolean;
        users: boolean;
        reporting: boolean;
        chat: boolean;
        games: boolean;
        settings: boolean;
      };
    };
    if (body.isSuperAdmin && !request.admin!.isSuperAdmin) {
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 403, 'Only super admin can create a super admin');
    }
    if (!body.username?.trim() || !body.password || body.password.length < 8)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Username and password (8+ chars) required'
      );
    const exists = await prisma.adminUser.findUnique({
      where: { username: body.username },
    });
    if (exists)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Username already exists'
      );
    await writeAudit({
      adminId: request.admin!.id,
      action: 'manager.create',
      targetType: 'manager',
      afterState: { username: body.username, permissions: body.permissions },
      ip: request.ip,
    });
    const manager = await prisma.adminUser.create({
      data: {
        username: body.username,
        passwordHash: await bcrypt.hash(body.password, 12),
        isSuperAdmin: !!(body.isSuperAdmin && request.admin!.isSuperAdmin),
        createdBy: request.admin!.id,
        permFinancial: !!body.permissions?.financial,
        permUsers: !!body.permissions?.users,
        permReporting: !!body.permissions?.reporting,
        permChat: !!body.permissions?.chat,
        permGames: !!body.permissions?.games,
        permSettings: !!body.permissions?.settings,
      },
    });
    return ok({ id: manager.id, username: manager.username }, request.requestId!);
  });

  // PATCH /managers/:id — update permissions (super can do anything, admin can edit non-super only)
  app.patch('/managers/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      permissions?: {
        financial?: boolean;
        users?: boolean;
        reporting?: boolean;
        chat?: boolean;
        games?: boolean;
        settings?: boolean;
      };
      isSuperAdmin?: boolean;
      password?: string;
    };
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Manager not found');
    if (target.isSuperAdmin && !request.admin!.isSuperAdmin) {
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 403, 'Admins cannot modify a super admin');
    }
    if (body.isSuperAdmin !== undefined && !request.admin!.isSuperAdmin) {
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 403, 'Only super admin can change super admin status');
    }
    if (body.isSuperAdmin === false && target.id === request.admin!.id && target.isSuperAdmin) {
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'You cannot remove your own super admin status');
    }
    const updateData: Record<string, unknown> = {};
    if (body.permissions) {
      if (typeof body.permissions.financial === 'boolean') updateData.permFinancial = body.permissions.financial;
      if (typeof body.permissions.users === 'boolean') updateData.permUsers = body.permissions.users;
      if (typeof body.permissions.reporting === 'boolean') updateData.permReporting = body.permissions.reporting;
      if (typeof body.permissions.chat === 'boolean') updateData.permChat = body.permissions.chat;
      if (typeof body.permissions.games === 'boolean') updateData.permGames = body.permissions.games;
      if (typeof body.permissions.settings === 'boolean') updateData.permSettings = body.permissions.settings;
    }
    if (body.isSuperAdmin !== undefined && request.admin!.isSuperAdmin) {
      updateData.isSuperAdmin = !!body.isSuperAdmin;
    }
    if (body.password) {
      if (body.password.length < 8) throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Password must be 8+ characters');
      updateData.passwordHash = await bcrypt.hash(body.password, 12);
    }
    if (Object.keys(updateData).length === 0) {
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'No changes provided');
    }
    await writeAudit({
      adminId: request.admin!.id,
      action: 'manager.update',
      targetType: 'manager',
      targetId: target.id,
      beforeState: { username: target.username, isSuperAdmin: target.isSuperAdmin, permFinancial: target.permFinancial, permUsers: target.permUsers, permReporting: target.permReporting, permChat: target.permChat, permGames: target.permGames, permSettings: target.permSettings },
      afterState: { ...updateData },
      ip: request.ip,
    });
    const updated = await prisma.adminUser.update({ where: { id }, data: updateData });
    return ok({ id: updated.id, username: updated.username, isSuperAdmin: updated.isSuperAdmin }, request.requestId!);
  });

  // ── SETTINGS ───────────────────────────────────────────────────────────
  app.get('/settings', { preHandler: [adminAuthMiddleware] }, async (request) =>
    // maskSmtpSettings swaps the stored smtp_password for a mask and reports
    // smtp_password_set — the secret never leaves the database.
    ok(maskSmtpSettings(await getSettings()), request.requestId!)
  );

  // POST /settings/smtp-test — verify the configured (or unsaved) mail settings.
  // Body: { to?: string, settings?: { ...smtp fields } } — when `settings` is
  // supplied the values are tested WITHOUT saving, so an admin can try Gmail
  // credentials before committing them.
  app.post('/settings/smtp-test', { preHandler: [adminAuthMiddleware] }, async (request) => {
    if (!request.admin!.isSuperAdmin) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        403,
        'Only super admin can send a test email (it uses the stored mail credentials)'
      );
    }
    const body = (request.body ?? {}) as {
      to?: string;
      settings?: Record<string, unknown>;
    };
    const stored = await getSettings();

    let smtp;
    let recipients: string[];
    if (body.settings && typeof body.settings === 'object') {
      const invalid = validateSmtpPatch(body.settings);
      if (invalid) throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, invalid);
      // Merge over the stored values so a blank password field means "use the
      // saved one" rather than "send an empty password".
      const merged = { ...stored, ...prepareSmtpPatch(body.settings) };
      const withSavedPassword = {
        ...merged,
        ...(SMTP_PASSWORD_KEY in merged ? {} : { [SMTP_PASSWORD_KEY]: stored[SMTP_PASSWORD_KEY] }),
      };
      smtp = smtpFromSettings(withSavedPassword);
      recipients = recipientsFromSettings(withSavedPassword);
    } else {
      smtp = smtpFromSettings(stored);
      recipients = recipientsFromSettings(stored);
    }

    const to = typeof body.to === 'string' && body.to.includes('@') ? body.to.trim() : undefined;

    // "Switched off" and "not set up" are different problems — say which one it is.
    const enabled =
      typeof body.settings?.backup_email_enabled === 'boolean'
        ? body.settings.backup_email_enabled
        : emailBackupEnabled(stored);
    if (!enabled) {
      return ok(
        {
          ok: false,
          error:
            'Email delivery is switched off. Turn the "Email the nightly backup" switch on, then test again.',
        },
        request.requestId!
      );
    }

    const result = await sendTestEmail({
      smtp,
      recipientOverride: to,
      recipients,
    });
    if (!result.ok) {
      // A test that fails is the POINT of a test — return 200 with ok:false so
      // the panel shows the provider's message instead of a generic error toast.
      await writeAudit({
        adminId: request.admin!.id,
        action: 'settings.smtp_test',
        targetType: 'settings',
        afterState: { ok: false, host: smtp?.host, error: result.error },
        ip: request.ip,
      });
      return ok({ ok: false, error: result.error }, request.requestId!);
    }
    await writeAudit({
      adminId: request.admin!.id,
      action: 'settings.smtp_test',
      targetType: 'settings',
      afterState: { ok: true, host: smtp?.host, to: result.accepted },
      ip: request.ip,
    });
    return ok({ ok: true, accepted: result.accepted }, request.requestId!);
  });
  app.patch('/settings', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const body = request.body as Record<string, unknown>;
    const rtpCeiling = await getSettings().then((s) => s.rtp_ceiling);
    if (
      body.rtp_ceiling !== undefined &&
      Number(body.rtp_ceiling) !== Number(rtpCeiling)
    ) {
      throw new AppError(
        ERROR_CODES.CONF_EXCEEDS_CEILING,
        422,
        'RTP ceiling is hard-coded and cannot be changed'
      );
    }
    // Validate every key against a known schema. Previously ANY key with ANY
    // value was written straight through, so a typo in `bet_spend_priority` or
    // an emptied `daily_checkin_ladder` broke core flows at runtime (the
    // check-in interpolation threw a 500 on an empty ladder).
    const invalid = validateSettingsPatch(body) ?? validateSmtpPatch(body);
    if (invalid) throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, invalid);
    // Mail credentials decide WHERE backups are sent — a manager must not be
    // able to redirect them to their own mailbox. Super admin only, like the
    // backup export/restore routes.
    const touchesMail = Object.keys(body).some(
      (k) => k.startsWith('smtp_') || k.startsWith('backup_email_')
    );
    if (touchesMail && !request.admin!.isSuperAdmin) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        403,
        'Only super admin can change email/backup settings'
      );
    }
    // Encrypt the SMTP password before it touches the DB; a mask/blank value is
    // dropped so saving the form without retyping keeps the stored secret.
    const smtpPatch = prepareSmtpPatch(body);
    const passwordChanged = SMTP_PASSWORD_KEY in smtpPatch;
    // v1.4.1: never let min/max inversion slip through — a merged
    // min_deposit > max_deposit (or the withdrawal pair) would block the
    // whole money lane with no recoverable UI. Compare the EFFECTIVE values.
    {
      const cur = await getSettings();
      const eff = (k: string) => Number(body[k] ?? (cur as Record<string, unknown>)[k]);
      for (const [lo, hi, label] of [
        ['min_deposit', 'max_deposit', 'deposit'],
        ['min_withdrawal', 'max_withdrawal', 'withdrawal'],
      ] as const) {
        if (eff(lo) > eff(hi))
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            `${lo} (${eff(lo)}) cannot be greater than ${hi} (${eff(hi)}) — the ${label} window would be empty`
          );
      }
    }
    // H-19: multi-key settings writes + their audit are ONE transaction now —
    // the old loop could leave a HALF-applied settings patch while recording
    // a clean "settings.update" audit row.
    await prisma.$transaction(async (tx) => {
      for (const [key, value] of Object.entries(smtpPatch)) {
        await tx.setting.upsert({
          where: { key },
          create: { key, value: value as never, updatedBy: request.admin!.username },
          update: { value: value as never, updatedBy: request.admin!.username },
        });
      }
      await writeAuditTx(tx, {
        adminId: request.admin!.id,
        action: 'settings.update',
        targetType: 'settings',
        // The audit log is append-only and readable in the panel — never write
        // the SMTP password into it (encrypted or not).
        afterState: passwordChanged ? { ...body, smtp_password: '[redacted]' } : body,
        ip: request.ip,
      });
    });
    // settings cache invalidation must happen after commit
    await redis.del(keys.settingsCache()).catch(() => {});
    // D-073: demo toggle should apply to the lobby instantly (games list is cached 30s)
    if ('demo_mode_enabled' in body) await redis.del('cache:lobby');
    return ok({ updated: true }, request.requestId!);
  });

  // ── AUDIT LOG (append-only view) ───────────────────────────────────────
  app.get('/audit-log', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as {
      adminId?: string;
      action?: string;
      from?: string;
      to?: string;
      page?: string;
    };
    const page = Math.max(1, parseInt(q.page || '1'));
    const where = {
      ...(q.adminId ? { adminId: q.adminId } : {}),
      ...(q.action ? { action: { contains: q.action } } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 50,
        take: 50,
      }),
      prisma.adminAuditLog.count({ where }),
    ]);
    return ok({ data: rows, total }, request.requestId!);
  });

  // ── BROADCASTS ─────────────────────────────────────────────────────────
  app.post('/broadcasts', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const body = request.body as { title: string; body: string; actionUrl?: string };
    // M-12: title/body were unchecked (undefined → Prisma 500) and actionUrl
    // accepted anything, including javascript: URIs rendered into every bell.
    if (
      typeof body?.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 120
    )
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Title is required (max 120 chars)'
      );
    if (typeof body?.body !== 'string' || !body.body.trim() || body.body.length > 500)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Body is required (max 500 chars)'
      );
    if (
      body.actionUrl !== undefined &&
      !/^(https?:\/\/|\/)[^\s]{1,489}$/.test(String(body.actionUrl))
    )
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'actionUrl must be an http(s) URL or site path'
      );
    await writeAudit({
      adminId: request.admin!.id,
      action: 'broadcast.send',
      targetType: 'broadcast',
      afterState: { title: body.title },
      ip: request.ip,
    });
    const notif = await prisma.notification.create({
      data: {
        userId: null,
        type: 'broadcast',
        title: body.title.slice(0, 120),
        body: body.body.slice(0, 500),
        actionUrl: body.actionUrl,
      },
    });
    const io = (globalThis as { __io?: import('socket.io').Server }).__io;
    io?.emit('notification:new', {
      id: notif.id,
      type: 'broadcast',
      title: notif.title,
      body: notif.body,
    });
    return ok({ id: notif.id }, request.requestId!);
  });
  app.post(
    '/broadcasts/:id/retract',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      await writeAudit({
        adminId: request.admin!.id,
        action: 'broadcast.retract',
        targetType: 'broadcast',
        targetId: id,
        ip: request.ip,
      });
      await prisma.notification.update({ where: { id }, data: { isRetracted: true } });
      return ok({ retracted: true }, request.requestId!);
    }
  );

  // ── SUPPORT INBOX ──────────────────────────────────────────────────────
  app.get(
    '/support/conversations',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const q = request.query as { tab?: string; search?: string; page?: string };
      const page = Math.max(1, parseInt(q.page || '1'));
      const tab = q.tab || 'active';
      const search = (q.search || '').trim();
      const statusWhere =
        tab === 'closed'
          ? { status: 'CLOSED' as const }
          : tab === 'mine'
            ? { status: { not: 'CLOSED' as const }, assignedTo: request.admin!.id }
            : tab === 'all'
              ? {}
              : { status: { not: 'CLOSED' as const } };
      const where = {
        ...statusWhere,
        ...(search
          ? {
              OR: [
                { subject: { contains: search, mode: 'insensitive' as const } },
                {
                  user: {
                    OR: [
                      { phone: { contains: search } },
                      {
                        displayName: { contains: search, mode: 'insensitive' as const },
                      },
                    ],
                  },
                },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.supportConversation.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * 40,
          take: 40,
          include: { user: { select: { phone: true, displayName: true } } },
        }),
        prisma.supportConversation.count({ where }),
      ]);
      const last = await lastMessagesByConvo(rows.map((r) => r.id));
      return ok(
        {
          data: rows.map((c) => {
            const lm = last.get(c.id) ?? null;
            return {
              id: c.id,
              userId: c.userId,
              subject: c.subject,
              category: c.category,
              status: c.status,
              assignedTo: c.assignedTo,
              referenceType: c.referenceType,
              referenceId: c.referenceId,
              updatedAt: c.updatedAt,
              createdAt: c.createdAt,
              userPhone: c.user ? maskPhone(c.user.phone) : null,
              userName: c.user?.displayName ?? null,
              lastMessage: lm
                ? {
                    body: previewOf(lm),
                    senderType: lm.senderType,
                    createdAt: lm.createdAt,
                  }
                : null,
              unreadCount: unreadCount({
                last: lm,
                lastReadAt: c.adminLastReadAt,
                from: 'USER',
              }),
              waitMs: waitMsFromLast(lm),
            };
          }),
          total,
        },
        request.requestId!
      );
    }
  );

  app.get(
    '/support/conversations/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const convo = await prisma.supportConversation.findUnique({ where: { id } });
      if (!convo)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      const ctx = await loadPlayerContext(convo.userId);
      return ok(
        {
          id: convo.id,
          userId: convo.userId,
          subject: convo.subject,
          category: convo.category,
          status: convo.status,
          assignedTo: convo.assignedTo,
          referenceType: convo.referenceType,
          referenceId: convo.referenceId,
          createdAt: convo.createdAt,
          updatedAt: convo.updatedAt,
          player: {
            id: ctx.user?.id,
            displayName: ctx.user?.displayName ?? null,
            phone: ctx.user ? maskPhone(ctx.user.phone) : null,
            status: ctx.user?.status,
            kycStatus: ctx.user?.kycStatus,
            createdAt: ctx.user?.createdAt,
            wallet: ctx.wallet,
            deposits: ctx.deposits,
            withdrawals: ctx.withdrawals,
            fraudOpen: ctx.fraudOpen,
          },
        },
        request.requestId!
      );
    }
  );

  // D-079: admin message thread view (the player route 401s for admins)
  app.get(
    '/support/conversations/:id/messages',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const convo = await prisma.supportConversation.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!convo)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      const rows = await prisma.supportMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      });
      await prisma.supportConversation.update({
        where: { id },
        data: { adminLastReadAt: new Date() },
      });
      return ok(rows.map(serializeMessage), request.requestId!);
    }
  );

  app.patch(
    '/support/conversations/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        status?: 'OPEN' | 'ASSIGNED' | 'CLOSED';
        assignedTo?: string;
      };
      if (body.status && !['OPEN', 'ASSIGNED', 'CLOSED'].includes(body.status))
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid status');
      await writeAudit({
        adminId: request.admin!.id,
        action: 'support.update',
        targetType: 'conversation',
        targetId: id,
        afterState: body,
        ip: request.ip,
      });
      const updated = await prisma.supportConversation.update({
        where: { id },
        data: {
          status: body.status,
          assignedTo:
            body.status === 'CLOSED'
              ? undefined
              : (body.assignedTo ?? request.admin!.id),
        },
      });
      return ok(updated, request.requestId!);
    }
  );

  app.post(
    '/support/conversations/:id/reply',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { message: string };
      if (!body?.message?.trim())
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Message is required'
        );
      const convo = await prisma.supportConversation.findUnique({ where: { id } });
      if (!convo)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      if (convo.status === 'CLOSED')
        throw new AppError('CHAT_001', 409, 'This conversation is closed');
      await writeAudit({
        adminId: request.admin!.id,
        action: 'support.reply',
        targetType: 'conversation',
        targetId: id,
        afterState: { message: body.message.slice(0, 80) },
        ip: request.ip,
      });
      const msg = await prisma.supportMessage.create({
        data: {
          conversationId: id,
          senderType: 'ADMIN',
          senderId: request.admin!.id,
          userId: null,
          body: body.message.slice(0, 2000),
        },
      });
      await prisma.supportConversation.update({
        where: { id },
        data: { updatedAt: new Date(), adminLastReadAt: new Date() },
      });
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      const payload = { conversationId: id, message: serializeMessage(msg) };
      io?.to(`chat:${id}`).emit('chat:message', payload);
      if (convo.userId) {
        void notifyUser(
          convo.userId,
          'New support reply 💬',
          body.message.slice(0, 140),
          'support',
          '/support'
        );
      }
      return ok(serializeMessage(msg), request.requestId!);
    }
  );

  // ── LEGAL PAGES ────────────────────────────────────────────────────────
  app.get('/legal', { preHandler: [adminAuthMiddleware] }, async (request) =>
    ok(await prisma.legalPage.findMany(), request.requestId!)
  );
  app.put('/legal/:slug', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { slug } = request.params as { slug: string };
    const body = request.body as { title?: string; content?: string };
    await writeAudit({
      adminId: request.admin!.id,
      action: 'legal.update',
      targetType: 'legal',
      targetId: slug,
      afterState: { title: body.title },
      ip: request.ip,
    });
    const page = await prisma.legalPage.upsert({
      where: { slug_language: { slug, language: 'en' } },
      create: {
        slug,
        language: 'en',
        title: body.title || slug,
        content: body.content || '',
      },
      update: { title: body.title, content: body.content },
    });
    return ok(page, request.requestId!);
  });

  // ── DEPOSIT PACKAGES ────────────────────────────────────────────────────
  // Top-up bundles shown on the deposit page. `price` is what the player pays,
  // `credits` lands in the REAL wallet and `bonus` in the BONUS wallet when the
  // deposit is approved.
  app.get('/packages', { preHandler: [adminAuthMiddleware] }, async (request) =>
    ok(
      await prisma.depositPackage.findMany({
        orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
      }),
      request.requestId!
    )
  );

  const packageBody = z.object({
    name: z.string().min(1).max(64),
    price: z.number().nonnegative().max(1e9),
    credits: z.number().nonnegative().max(1e9),
    bonus: z.number().nonnegative().max(1e9).default(0),
    badge: z.string().max(32).nullish(),
    description: z.string().max(200).nullish(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    isActive: z.boolean().default(true),
  });

  app.post('/packages', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const b = packageBody.parse(request.body);
    const created = await prisma.depositPackage.create({
      data: {
        name: b.name,
        price: b.price.toFixed(2),
        credits: b.credits.toFixed(2),
        bonus: b.bonus.toFixed(2),
        badge: b.badge ?? null,
        description: b.description ?? null,
        sortOrder: b.sortOrder,
        isActive: b.isActive,
      },
    });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'package.create',
      targetType: 'package',
      targetId: created.id,
      afterState: b,
      ip: request.ip,
    });
    return ok(created, request.requestId!);
  });

  app.patch('/packages/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const b = packageBody.partial().parse(request.body);
    const before = await prisma.depositPackage.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.depositPackage.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.price !== undefined ? { price: b.price.toFixed(2) } : {}),
        ...(b.credits !== undefined ? { credits: b.credits.toFixed(2) } : {}),
        ...(b.bonus !== undefined ? { bonus: b.bonus.toFixed(2) } : {}),
        ...(b.badge !== undefined ? { badge: b.badge ?? null } : {}),
        ...(b.description !== undefined ? { description: b.description ?? null } : {}),
        ...(b.sortOrder !== undefined ? { sortOrder: b.sortOrder } : {}),
        ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      },
    });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'package.update',
      targetType: 'package',
      targetId: id,
      beforeState: { name: before.name, price: before.price.toString() },
      afterState: b,
      ip: request.ip,
    });
    return ok(updated, request.requestId!);
  });

  app.delete(
    '/packages/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      // Soft delete: deposits reference packages, and history must stay readable.
      const updated = await prisma.depositPackage.update({
        where: { id },
        data: { isActive: false },
      });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'package.deactivate',
        targetType: 'package',
        targetId: id,
        ip: request.ip,
      });
      return ok(updated, request.requestId!);
    }
  );

  // ── PAYMENT ACCOUNTS (D-068: structured CRUD — no raw JSON) ─────────────
  app.get('/payment-accounts', { preHandler: [adminAuthMiddleware] }, async (request) =>
    ok(
      await prisma.manualPaymentAccount.findMany({ orderBy: { displayOrder: 'asc' } }),
      request.requestId!
    )
  );

  app.post(
    '/payment-accounts',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const body = request.body as {
        type: string;
        label: string;
        accountNumber: string;
        holder?: string;
        bank?: string;
        iban?: string;
        isActive?: boolean;
        displayOrder?: number;
      };
      if (!PAY_ACCOUNT_TYPES.includes(body.type))
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Type must be mobile_wallet or bank'
        );
      if (!body.label?.trim() || !body.accountNumber?.trim())
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Label and account number are required'
        );
      const accountDetails = buildAccountDetails(body);
      await writeAudit({
        adminId: request.admin!.id,
        action: 'payment-account.create',
        afterState: { type: body.type, label: body.label, accountDetails },
        ip: request.ip,
      });
      const acc = await prisma.manualPaymentAccount.create({
        data: {
          type: body.type,
          label: body.label.trim(),
          accountDetails: accountDetails as never,
          isActive: body.isActive ?? true,
          displayOrder: Math.max(0, Math.min(999, body.displayOrder ?? 0)),
        },
      });
      return ok(acc, request.requestId!);
    }
  );

  app.patch(
    '/payment-accounts/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        type?: string;
        label?: string;
        accountNumber?: string;
        holder?: string;
        bank?: string;
        iban?: string;
        isActive?: boolean;
        displayOrder?: number;
      };
      const existing = await prisma.manualPaymentAccount.findUniqueOrThrow({
        where: { id },
      });
      if (body.type !== undefined && !PAY_ACCOUNT_TYPES.includes(body.type))
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Type must be mobile_wallet or bank'
        );
      const merged = {
        type: body.type ?? existing.type,
        label: body.label?.trim() ?? existing.label,
        accountNumber:
          body.accountNumber ??
          ((existing.accountDetails as Record<string, unknown>)
            .account_number as string),
        holder:
          body.holder ??
          ((existing.accountDetails as Record<string, unknown>).holder as string),
        bank:
          body.bank ??
          ((existing.accountDetails as Record<string, unknown>).bank as string),
        iban:
          body.iban ??
          ((existing.accountDetails as Record<string, unknown>).iban as string),
      };
      const data: Record<string, unknown> = {};
      if (body.label !== undefined) {
        if (!body.label.trim())
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Label is required'
          );
        data.label = body.label.trim();
      }
      if (body.type !== undefined) data.type = body.type;
      if (
        body.accountNumber !== undefined ||
        body.holder !== undefined ||
        body.bank !== undefined ||
        body.iban !== undefined
      ) {
        if (body.accountNumber !== undefined && !body.accountNumber.trim())
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Account number is required'
          );
        data.accountDetails = buildAccountDetails(merged) as never;
      }
      if (body.isActive !== undefined) data.isActive = !!body.isActive;
      if (body.displayOrder !== undefined)
        data.displayOrder = Math.max(0, Math.min(999, body.displayOrder));
      await writeAudit({
        adminId: request.admin!.id,
        action: 'payment-account.update',
        targetType: 'payment-account',
        targetId: id,
        afterState: body,
        ip: request.ip,
      });
      const acc = await prisma.manualPaymentAccount.update({ where: { id }, data });
      return ok(acc, request.requestId!);
    }
  );

  app.delete(
    '/payment-accounts/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      await writeAudit({
        adminId: request.admin!.id,
        action: 'payment-account.delete',
        targetType: 'payment-account',
        targetId: id,
        ip: request.ip,
      });
      await prisma.manualPaymentAccount.delete({ where: { id } });
      return ok({ deleted: true }, request.requestId!);
    }
  );

  // M-17: the impersonation endpoint/issuer was REMOVED. It minted a
  // `casino-impersonation` bearer token that NO middleware or client ever
  // accepted — dead code carrying a live "act as any player" signing path.
  // Player inspection remains available read-only via /panel/users/:id(+stats).

  // ── FRAUD SIGNALS — docs/20 §18 ────────────────────────────────────────
  app.get('/fraud-signals', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const allowed = ['new', 'reviewed', 'ignored'] as const;
    const status =
      q.status === 'all'
        ? undefined
        : (enumOr422(q.status, allowed, 'status') ?? 'new');
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.fraudSignal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          user: { select: { phone: true, displayName: true, status: true } },
        },
      }),
      prisma.fraudSignal.count({ where }),
    ]);
    return ok(
      {
        data: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          signal: r.signal,
          severity: r.severity,
          status: r.status,
          data: r.data,
          notes: r.notes,
          reviewedBy: r.reviewedBy,
          reviewedAt: r.reviewedAt,
          createdAt: r.createdAt,
          userPhone: r.user ? r.user.phone : null,
          userName: r.user?.displayName ?? null,
          userStatus: r.user?.status ?? null,
        })),
        total,
      },
      request.requestId!
    );
  });
  app.patch(
    '/fraud-signals/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        status: 'reviewed' | 'ignored';
        notes?: string;
      };
      if (body.status !== 'reviewed' && body.status !== 'ignored') {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'status must be reviewed or ignored'
        );
      }
      await writeAudit({
        adminId: request.admin!.id,
        action: 'fraud-signal.review',
        targetType: 'fraud',
        targetId: id,
        afterState: body,
        ip: request.ip,
      });
      const updated = await prisma.fraudSignal.update({
        where: { id },
        data: {
          status: body.status,
          notes: body.notes?.trim().slice(0, 500) || undefined,
          reviewedBy: request.admin!.id,
          reviewedAt: new Date(),
        },
      });
      return ok(updated, request.requestId!);
    }
  );

  // POST /users/:id/fraud-flag — manual signal from the player drawer
  app.post(
    '/users/:id/fraud-flag',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { severity?: string; notes?: string };
      const exists = await prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'User not found');
      const severity =
        body.severity === 'high' || body.severity === 'low' ? body.severity : 'medium';
      const notes = (body.notes || '').trim().slice(0, 500);
      await writeAudit({
        adminId: request.admin!.id,
        action: 'fraud-signal.flag',
        targetType: 'user',
        targetId: id,
        afterState: { severity, notes },
        ip: request.ip,
      });
      await raiseFraudSignal(
        id,
        'ADMIN_FLAG',
        severity,
        { notes, flaggedBy: request.admin!.username },
        { dedupe: false }
      );
      return ok({ flagged: true }, request.requestId!);
    }
  );
}

/**
 * Validate an admin settings patch. Returns an error message, or null when OK.
 * Unknown keys are rejected outright so a typo can't silently create a setting
 * that nothing reads (and that shadows a default).
 */
function validateSettingsPatch(body: Record<string, unknown>): string | null {
  const NUMERIC: Record<string, [number, number]> = {
    coin_rate: [0.000001, 1000000],
    min_deposit: [0, 1e9],
    max_deposit: [1, 1e12],
    min_withdrawal: [0, 1e9],
    max_withdrawal: [1, 1e12],
    withdrawal_fee_percent: [0, 100],
    withdrawal_fee_flat: [0, 1e9],
    global_min_bet: [0, 1e9],
    global_max_bet: [1, 1e9],
    global_max_payout: [1, 1e12],
    global_max_win_multiplier: [1, 10_000_000],
    rakeback_percent: [0, 100],
    referral_bonus_referrer: [0, 1e9],
    referral_bonus_referee: [0, 1e9],
    big_win_ticker_threshold: [0, 1e12],
    session_reminder_default_min: [0, 480],
    idle_logout_hours: [1, 24 * 30],
    seed_rotation_after_rounds: [1, 1e7],
    daily_checkin_min_balance: [0, 1e9],
    signup_bonus_amount: [0, 1e9],
    // v1.4.0: admin-controlled deposit pacing (SECONDS per operator request)
    deposit_rate_window_sec: [1, 86400],
    deposit_rate_max: [1, 100],
    // Security hardening — dual control, panel hygiene, password policy,
    // lockout, retention. 0 disables the dual-control thresholds / purge.
    withdrawal_dual_control_threshold: [0, 1e12],
    admin_credit_dual_control_threshold: [0, 1e12],
    admin_idle_timeout_minutes: [5, 1440],
    admin_step_up_minutes: [1, 240],
    password_min_length: [8, 64],
    password_history_depth: [0, 20],
    login_max_attempts: [3, 100],
    login_lock_minutes: [1, 1440],
    retention_login_events_days: [0, 3650],
    retention_notifications_days: [0, 3650],
    retention_recovery_requests_days: [0, 3650],
  };
  const BOOLEAN = [
    'maintenance_mode',
    'registration_open',
    'live_feed_visible_to_guests',
    'demo_mode_enabled',
    'lobby_show_game_names',
    'responsible_play_enabled',
    'ENABLE_DEMO_MODE',
    'ENABLE_REFERRAL_PROGRAM',
    'ENABLE_LEADERBOARD',
    'ENABLE_RAKEBACK',
    'ENABLE_WIN_STREAKS',
    'ENABLE_COIN_GIFTS',
    'ENABLE_CRYPTO_DEPOSITS',
    'ENABLE_PUSH_NOTIFICATIONS',
    // ENABLE_2FA_ADMIN removed on purpose — see the note below.
    'ENABLE_KYC',
    'signup_bonus_enabled',
    // Security hardening
    'password_reject_common',
    'security_watchdog_enabled',
    // NOTE: 'ENABLE_2FA_ADMIN' is deliberately NOT accepted any more. It was a
    // boolean an operator could save while nothing implemented 2FA — a switch
    // that produced false assurance about the single most dangerous account on
    // the platform. Admin 2FA is a known, documented gap (SECURITY.md); the flag
    // is not a substitute for it. Saving it now returns "Unknown setting".
  ];
  const STRING = ['currency_symbol', 'leaderboard_metric'];
  const ENUM: Record<string, string[]> = {
    rate_limit_fail_mode: ['memory', 'open', 'closed'],
    new_device_policy: ['notify', 'block'],
  };
  const DIFFICULTY = ['easy', 'normal', 'hard', 'impossible'];
  const WALLET_TYPES = ['REAL', 'BONUS', 'GIFTED'];

  for (const [key, value] of Object.entries(body)) {
    if (key === 'rtp_ceiling') continue; // handled above (immutable)
    // SMTP/mail keys are owned by validateSmtpPatch() — otherwise this loop
    // rejects them as "Unknown setting" and every mail config save fails.
    if (key in SMTP_STRING_KEYS || key === 'smtp_port' || (SMTP_BOOLEAN_KEYS as readonly string[]).includes(key)) {
      continue;
    }

    if (key in NUMERIC) {
      const [min, max] = NUMERIC[key]!;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) {
        return `${key} must be a number between ${min} and ${max}`;
      }
      continue;
    }
    if (BOOLEAN.includes(key)) {
      if (typeof value !== 'boolean') return `${key} must be true or false`;
      continue;
    }
    if (STRING.includes(key)) {
      if (typeof value !== 'string' || value.length > 64)
        return `${key} must be a string (max 64 chars)`;
      continue;
    }
    if (key in ENUM) {
      if (!ENUM[key]!.includes(String(value)))
        return `${key} must be one of ${ENUM[key]!.join(', ')}`;
      continue;
    }
    // Free-text security key: alert webhook URL (empty = disabled). Kept
    // separate from STRING because it may exceed the 64-char cap.
    if (key === 'alerts_webhook_url') {
      if (typeof value !== 'string' || value.length > 512)
        return 'alerts_webhook_url must be a string (max 512 chars)';
      if (value && !/^https?:\/\//.test(value)) return 'alerts_webhook_url must be an http(s) URL';
      continue;
    }
    if (key === 'game_difficulty') {
      if (!DIFFICULTY.includes(String(value)))
        return `game_difficulty must be one of ${DIFFICULTY.join(', ')}`;
      continue;
    }
    if (key === 'bet_spend_priority') {
      if (!Array.isArray(value) || value.length === 0)
        return 'bet_spend_priority must be a non-empty array';
      if (!value.every((v) => WALLET_TYPES.includes(String(v)))) {
        return `bet_spend_priority may only contain ${WALLET_TYPES.join(', ')}`;
      }
      if (new Set(value.map(String)).size !== value.length)
        return 'bet_spend_priority must not repeat a wallet';
      continue;
    }
    if (key === 'daily_checkin_ladder') {
      if (!Array.isArray(value) || value.length === 0) {
        return 'daily_checkin_ladder must have at least one { day, bonus } entry';
      }
      for (const e of value as Array<{ day?: unknown; bonus?: unknown }>) {
        const day = Number(e?.day),
          bonus = Number(e?.bonus);
        if (!Number.isInteger(day) || day < 1 || day > 365)
          return 'daily_checkin_ladder: day must be 1-365';
        if (!Number.isFinite(bonus) || bonus < 0)
          return 'daily_checkin_ladder: bonus must be >= 0';
      }
      continue;
    }
    if (key === 'win_streak_milestones') {
      if (!Array.isArray(value)) return 'win_streak_milestones must be an array';
      for (const e of value as Array<{ wins?: unknown; bonus?: unknown }>) {
        const wins = Number(e?.wins),
          bonus = Number(e?.bonus);
        if (!Number.isInteger(wins) || wins < 1)
          return 'win_streak_milestones: wins must be a positive integer';
        if (!Number.isFinite(bonus) || bonus < 0)
          return 'win_streak_milestones: bonus must be >= 0';
      }
      continue;
    }
    return `Unknown setting "${key}"`;
  }
  return null;
}

/** Build the canonical accountDetails JSON from a structured form body. */
function buildAccountDetails(body: {
  accountNumber: string;
  holder?: string;
  bank?: string;
  iban?: string;
}): Record<string, string> {
  const details: Record<string, string> = {
    account_number: String(body.accountNumber).trim(),
    holder: String(body.holder || '').trim(),
  };
  if (body.bank) details.bank = String(body.bank).trim();
  if (body.iban) details.iban = String(body.iban).trim();
  return details;
}

function signAdmin(adminId: string, sessionVersion = 0): string {
  return jwt.sign(
    { sub: adminId, role: JWT_ROLE_ADMIN, sv: sessionVersion },
    getJwtPrivateKey(),
    {
      algorithm: 'RS256',
      expiresIn: '8h',
      issuer: JWT_ISSUER_ADMIN,
    }
  );
}
