// apps/api/src/middleware/index.ts — auth, admin auth + permissions, CSRF,
// rate limiting, responsible play. (docs/14 + docs/19 §7 + docs/20 §1)
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import { AppError } from '../lib/core';
import { getJwtPublicKey } from '../lib/jwt-keys';
import { prisma } from '../db/prisma';
import { redis, logRedisIssue } from '../db/redis';
import { startOfDay } from '../lib/day-boundary';
import {
  idleDecision,
  normalizeFailMode,
  sessionVersionMatches,
  stepUpFresh,
  stepUpMessage,
} from '../services/securityPolicy';
import { getNumericSetting } from '../services/settings';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import {
  PANEL_ROUTE_PERM,
  ALL_PERM_FLAGS,
  permForPath,
  type AdminPermissions,
  type PermFlag,
} from '@casino/shared/constants/panel-perms';
import {
  JWT_ISSUER_USER,
  JWT_ISSUER_ADMIN,
  JWT_ISSUER_REFERRAL,
  JWT_ROLE_USER,
  JWT_ROLE_ADMIN,
  JWT_ROLE_REFERRAL,
} from '../lib/jwt-claims';
import type { AdminUser } from '../generated/prisma/client';

export {
  JWT_ISSUER_USER,
  JWT_ISSUER_ADMIN,
  JWT_ISSUER_REFERRAL,
  JWT_ROLE_USER,
  JWT_ROLE_ADMIN,
  JWT_ROLE_REFERRAL,
} from '../lib/jwt-claims';
export { JWT_ISSUER_REFRESH, JWT_ROLE_REFRESH } from '../lib/jwt-claims';

/**
 * Referral-agent auth (Bearer only). Tokens carry the referral issuer + role,
 * so a player or admin token signed with the same key can never satisfy this.
 * The underlying user must still be flagged isReferralAgent and ACTIVE.
 */
export async function referralAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const token = extractBearer(request);
  if (!token)
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Referral authentication required'
    );
  const payload = jwt.verify(token, getJwtPublicKey(), {
    algorithms: ['RS256'],
    issuer: JWT_ISSUER_REFERRAL,
  }) as { sub: string; role?: string };
  if (payload.role !== JWT_ROLE_REFERRAL) {
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Invalid token for this endpoint'
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, isReferralAgent: true, status: true },
  });
  if (!user || !user.isReferralAgent || user.status !== 'ACTIVE')
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Referral account is not active'
    );
  request.user = { id: user.id, role: 'user' };
}

// ── AUTH (access token, RS256, 15 min) ─────────────────────────────────────
export interface AuthUser {
  id: string;
  role: 'user' | 'demo' | 'admin';
  /** D-078: set by dual-auth middleware (e.g. deposit proofs) so ownership
   *  checks can skip for admins without guessing roles. */
  isAdmin?: boolean;
}
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    admin?: import('../generated/prisma/client').AdminUser;
    requestId?: string;
  }
}

/** Demo phone constant — the shared demo account created by the seed (docs/20 §9). */
export const DEMO_USER_PHONE = () => process.env.DEMO_USER_PHONE || '+00000000000';

/**
 * Auth middleware with demo-mode bypass (docs/20 §9):
 * requests carrying `X-Demo-Mode: true` run as the shared demo user (no wallet
 * movement server-side; rounds flagged demo). Everything else = normal auth.
 */
export async function authOrDemoMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const isDemo = request.headers['x-demo-mode'] === 'true';
  if (!isDemo) return authMiddleware(request, reply);

  const rawSession = String(request.headers['x-demo-session'] ?? '');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(rawSession)) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      400,
      'Demo session is missing or invalid'
    );
  }
  const sessionHash = crypto.createHash('sha256').update(rawSession).digest('hex');
  const phone = `demo:${sessionHash.slice(0, 32)}`;
  let demoUser = await prisma.user.findUnique({ where: { phone } });
  if (!demoUser) {
    try {
      demoUser = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            phone,
            passwordHash: 'DEMO_ACCOUNT_NO_LOGIN',
            displayName: 'Demo Player',
            status: 'ACTIVE',
          },
        });
        await tx.wallet.create({ data: { userId: user.id } });
        const serverSeed = PROVABLY_FAIR.generateServerSeed();
        await tx.seedPair.create({
          data: {
            userId: user.id,
            serverSeed,
            serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
            clientSeed: 'demo',
          },
        });
        return user;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      demoUser = await prisma.user.findUnique({ where: { phone } });
    }
  }
  if (!demoUser)
    throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Demo mode is unavailable');
  request.user = { id: demoUser.id, role: 'demo' };
}

export async function authMiddleware(request: FastifyRequest, _reply: FastifyReply) {
  // Bearer only. An `access_token` COOKIE fallback used to be accepted here —
  // nothing ever set that cookie, but an ambient credential would have made
  // every non-CSRF-protected route CSRF-able. Removed deliberately.
  const token = extractBearer(request);
  if (!token)
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Authentication required');

  try {
    // Verify issuer AND role: player and admin tokens are signed with the SAME
    // RSA key, so without these claims an admin token would authenticate as a
    // player (and vice versa). Previously only the `sub` lookup separated them,
    // which is collision-avoidance, not an authorization boundary.
    const payload = jwt.verify(token, getJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: JWT_ISSUER_USER,
    }) as { sub: string; role?: string; sv?: number };
    if (payload.role !== JWT_ROLE_USER) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        401,
        'Invalid token for this endpoint'
      );
    }
    let user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, selfExcludedUntil: true, sessionVersion: true },
    });
    if (!user)
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Account not found');
    // SESSION VERSION: "sign out everywhere", a password change or a recovery
    // reset kills tokens that are ALREADY issued — not just future refreshes.
    if (!sessionVersionMatches(payload.sv, user.sessionVersion))
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        401,
        'Session ended — sign in again'
      );
    // IDLE LOGOUT (docs/14). The activity key used to be written on every
    // request and never read, so an unattended device stayed signed in for the
    // full refresh lifetime. Now the key is checked first; a missing key is
    // treated as active so a deploy never signs everyone out at once.
    try {
      const raw = await redis.get(`session:${user.id}`);
      if (raw) {
        const seen = (JSON.parse(raw) as { lastActivity?: number }).lastActivity ?? 0;
        const idleHours = await getNumericSetting('idle_logout_hours', 24, {
          min: 1,
          allowZero: true,
        });
        if (seen && Date.now() - seen > idleHours * 3600_000) {
          throw new AppError(
            ERROR_CODES.AUTH_TOKEN_EXPIRED,
            401,
            'You were signed out after a long period of inactivity — please sign in again'
          );
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      logRedisIssue('session-idle', e); // Redis down ⇒ fail open, as documented
    }
    if (
      user.status === 'SELF_EXCLUDED' &&
      user.selfExcludedUntil &&
      user.selfExcludedUntil <= new Date()
    ) {
      // Timed exclusions reactivate automatically at expiry. Previously status
      // stayed SELF_EXCLUDED forever, so login succeeded but every API call 403'd.
      user = await prisma.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', selfExcludedUntil: null },
        select: { id: true, status: true, selfExcludedUntil: true, sessionVersion: true },
      });
    }
    if (user.status === 'SELF_EXCLUDED') {
      throw new AppError(
        ERROR_CODES.RESP_SELF_EXCLUDED,
        403,
        'Your self-exclusion is active'
      );
    }
    if (user.status !== 'ACTIVE')
      throw new AppError(
        ERROR_CODES.AUTH_ACCOUNT_SUSPENDED,
        403,
        'Account is not active'
      );
    request.user = { id: user.id, role: 'user' };
    // touch activity for 24h idle logout (docs/14). D-081: FAIL-OPEN — a Redis
    // failure here must NOT turn valid requests into 401s.
    try {
      await redis.set(
        `session:${user.id}`,
        JSON.stringify({ lastActivity: Date.now() }),
        'EX',
        24 * 3600
      );
    } catch {
      /* session tracking best-effort */
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 401, 'Session expired');
  }
}

// ── ADMIN AUTH + PERMISSIONS (RS256, issuer JWT_ISSUER_ADMIN, 8h) ──────────
// PermFlag, PANEL_ROUTE_PERM and ALL_PERM_FLAGS now live in
// @casino/shared/constants/panel-perms so the web panel's side nav filters
// itself from the SAME map this middleware enforces. Two hand-maintained
// copies would drift: the nav would show a section the server then 403s (or
// hide one the operator is allowed to reach).
//
// Semantics are UNCHANGED except managers: DEFAULT-DENY — routes absent from
// the map are super-admin only, so a new panel route can never silently become
// reachable by every manager. /panel/backup/* relies on it; /panel/managers is
// an explicit exception — any admin may access, hierarchy enforced in handlers.
export const PERM_ROUTE = PANEL_ROUTE_PERM;

/**
 * Permission flags held by an admin, as reported by /panel/auth/me so the
 * panel can hide unreachable sections. A super-admin short-circuits every
 * `permFor` check, so it holds all six — reporting fewer would hide sections
 * the server would happily serve.
 */
export function adminPermissions(admin: {
  isSuperAdmin: boolean;
  permFinancial: boolean;
  permUsers: boolean;
  permReporting: boolean;
  permChat: boolean;
  permGames: boolean;
  permSettings: boolean;
}): AdminPermissions {
  if (admin.isSuperAdmin) {
    return Object.fromEntries(ALL_PERM_FLAGS.map((f) => [f, true])) as AdminPermissions;
  }
  return {
    permFinancial: admin.permFinancial,
    permUsers: admin.permUsers,
    permReporting: admin.permReporting,
    permChat: admin.permChat,
    permGames: admin.permGames,
    permSettings: admin.permSettings,
  };
}

export async function adminAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  // cookie first — a player's bearer token must never be tried against the admin secret
  const token = extractCookie(request, 'admin_token') || extractBearer(request);
  if (!token)
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Admin authentication required'
    );
  try {
    // Admin tokens must carry the admin issuer + role — a player's token signed
    // with the same key must never satisfy this middleware.
    const payload = jwt.verify(token, getJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: JWT_ISSUER_ADMIN,
    }) as { sub: string; role?: string; sv?: number };
    if (payload.role !== JWT_ROLE_ADMIN) {
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        401,
        'Invalid token for this endpoint'
      );
    }
    const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin)
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Admin not found');
    // Session version: sign-out (or any credential change) invalidates cookies
    // that are already in the wild instead of letting them live out 8 hours.
    if (!sessionVersionMatches(payload.sv, admin.sessionVersion))
      throw new AppError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        401,
        'Panel session ended — sign in again'
      );

    // ── IDLE TIMEOUT (security hardening) ──────────────────────────────────
    // The cookie is valid for 8h; an unattended browser must not stay a live
    // admin session for all of it. Sliding: any panel request within the
    // window keeps the session alive. Fail-open on a settings/database hiccup —
    // this is a hygiene control, not the thing standing between a thief and the
    // money (that is requireStepUp, which fails closed).
    {
      const { getNumericSetting } = await import('../services/settings');
      let timeoutMinutes = 0;
      try {
        timeoutMinutes = await getNumericSetting('admin_idle_timeout_minutes', 60, { min: 0 });
      } catch {
        timeoutMinutes = 0;
      }
      const idle = idleDecision(admin.lastActiveAt, { timeoutMinutes });
      if (idle.expired) {
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_EXPIRED,
          401,
          `Panel session ended after ${idle.idleMinutes} minutes of inactivity — sign in again`
        );
      }
      // Touch the stamp at most once a minute, so a polling dashboard does not
      // write to the database on every request.
      const stamp = admin.lastActiveAt ? new Date(admin.lastActiveAt).getTime() : 0;
      if (Date.now() - stamp > 60_000) {
        void prisma.adminUser
          .update({ where: { id: admin.id }, data: { lastActiveAt: new Date() } })
          .catch(() => undefined);
      }
    }

    request.admin = admin as AdminUser;

    // Permission check per route prefix. DEFAULT-DENY: any /panel/ route that
    // isn't explicitly mapped in PERM_ROUTE requires super-admin, so adding a
    // new panel route can never silently expose it to every manager.
    //
    // H-06: /panel/auth/me and /panel/auth/ws-token are the IDENTITY
    // endpoints every manager's panel session calls immediately after login —
    // they must pass for ANY authenticated admin, otherwise non-super
    // managers can never complete authentication at all.
    //
    // /panel/auth/reauth (step-up) belongs to the SAME category: it only
    // re-asserts the caller's own identity. Gating it behind a permission made
    // step-up unusable for exactly the people who need it — a manager holding
    // permFinancial was refused 403 on the re-auth prompt, so every payout
    // approval they were entitled to make could never clear the AUTH_010 gate.
    const selfPaths = new Set([
      '/panel/auth/me',
      '/panel/auth/ws-token',
      '/panel/auth/reauth',
    ]);
    const selfPath = request.url.split('?')[0]!.replace(/^\/api\/v1/, '');
    // Managers: any authenticated admin may view/edit non-super managers, but
    // the route handler enforces the super-admin-target guard (admin can never
    // touch a super admin). This implements: super can do anything, admin can
    // manage other admins/managers but not super admins.
    if (
      selfPath === '/panel/managers' ||
      selfPath.startsWith('/panel/managers/')
    ) {
      return;
    }
    if (!admin.isSuperAdmin && !selfPaths.has(selfPath)) {
      const flag = permFor(request.url);
      if (!flag)
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'You do not have permission to access this section'
        );
      if (!admin[flag])
        throw new AppError(
          ERROR_CODES.AUTH_TOKEN_INVALID,
          403,
          'You do not have permission to access this section'
        );
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Admin session expired');
  }
}

/**
 * Longest-prefix permission lookup for a panel path.
 *
 * BUGFIX: this used to match `request.url` (e.g. "/api/v1/panel/deposits")
 * against bare "/panel/..." keys, so `startsWith` NEVER matched and permFor()
 * always returned undefined — every manager effectively had every permission.
 * Normalize by stripping the "/api/v1" mount prefix and the query string first.
 */
export function permFor(url: string): PermFlag | undefined {
  const path = url.split('?')[0]!.replace(/^\/api\/v1/, '');
  // The matching rule itself (fund special-case, panel root, longest-prefix)
  // lives in shared so the web panel's nav filter uses the identical logic.
  return permForPath(path);
}

// ── CSRF (double-submit cookie — docs/14) ──────────────────────────────────
export async function csrfMiddleware(request: FastifyRequest, _reply: FastifyReply) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const cookieToken = request.cookies?.['csrf_token'];
  const headerToken = request.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new AppError('CSRF_INVALID', 403, 'Invalid CSRF token');
  }
}

// ── RATE LIMITING (redis-backed — anti-abuse only; docs/14) ────────────────
// NOTE: the per-player bet limiter was removed by operator decision (D-042) —
// players may play as often as they like. login/signup protect against
// brute-force; deposit/withdraw against fraud; api/ws protect the server.
type LimitKey =
  | 'login'
  | 'signup'
  | 'deposit'
  | 'upload'
  | 'withdraw'
  | 'api'
  | 'ws'
  | 'supportConvo'
  | 'supportMsg'
  | 'recoveryRequest'
  | 'recoveryCheck'
  | 'recoveryMsg'
  | 'recoveryRedeem'
  | 'loginAcct'
  | 'passwordChange'
  | 'adminReauth'
  | 'bet';
const LIMITS: Record<LimitKey, { windowSec: number; max: number }> = {
  // D-103: login raised 5 → 20 per 15 min. A 5-attempt cap locked out real
  // users (mistyped password + retries + a shared/NAT IP) for 15 min, which
  // looked like "the site is broken". 20 still blocks brute-force.
  login: { windowSec: 15 * 60, max: 20 },
  signup: { windowSec: 3600, max: 10 }, // 10/hour per IP (D-060 — was 3, too low for real users)
  deposit: { windowSec: 3600, max: 5 },
  // v1.4.0: proof uploads are FILE transfers, not money requests. They used
  // to share the 'deposit' bucket, so with max=5/hr a normal
  // presign+upload+create flow burned ~3 of the 5 slots and operators saw
  // "players can only add amount once an hour". Uploads get their own
  // generous bucket; ONLY a created deposit request consumes the
  // admin-tunable deposit_rate_max / deposit_rate_window_sec budget.
  upload: { windowSec: 3600, max: 60 },
  withdraw: { windowSec: 3600, max: 3 },
  api: { windowSec: 60, max: 200 },
  ws: { windowSec: 60, max: 5 },
  // M-06: support abuse ceilings (per user, fail-open like the rest)
  supportConvo: { windowSec: 3600, max: 10 }, // 10 new conversations/hour
  supportMsg: { windowSec: 60, max: 20 }, // 20 messages/minute per user
  // Account recovery (routes/recovery.ts) — public, so these are per IP and
  // deliberately tight. Filing a request is rare; polling the ticket page is
  // not, hence the looser status bucket. `recoveryMsg` is keyed by ticket
  // hash, `recoveryRedeem` by IP (guessing a 59-bit code is hopeless anyway).
  recoveryRequest: { windowSec: 3600, max: 3 },
  recoveryCheck: { windowSec: 3600, max: 60 },
  recoveryMsg: { windowSec: 60, max: 20 },
  recoveryRedeem: { windowSec: 3600, max: 20 },
  // Per ACCOUNT, not per IP: the IP limiter cannot see a botnet spraying one
  // account from many addresses. Account lockout (services/securityPolicy) is
  // the hard stop; this is the softer ring in front of it.
  loginAcct: { windowSec: 15 * 60, max: 12 },
  passwordChange: { windowSec: 3600, max: 5 },
  adminReauth: { windowSec: 600, max: 10 },
  // Bets were previously unlimited per player (only responsible-play limits
  // applied). 30/min per account stops scripted bet-spam / odds probing while
  // staying far above any human pace.
  bet: { windowSec: 60, max: 30 },
};

/**
 * In-process rate-limit windows, used ONLY when Redis is unreachable.
 *
 * Deliberately simple: a fixed window per key, bounded in size so a flood
 * cannot turn the fallback into a memory leak. It is per-process, so with N
 * replicas a caller effectively gets N windows — far weaker than Redis, and far
 * stronger than switching the limiter off entirely.
 */
const MEM_LIMIT_MAX_KEYS = 20_000;
const memWindows = new Map<string, { count: number; resetAt: number }>();

export function memoryIncrement(key: string, windowSec: number): number {
  const now = Date.now();
  const existing = memWindows.get(key);
  if (!existing || existing.resetAt <= now) {
    if (memWindows.size >= MEM_LIMIT_MAX_KEYS) {
      // Drop the oldest half rather than growing without bound.
      const entries = [...memWindows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) memWindows.delete(k);
    }
    memWindows.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/** Test/maintenance hook: how many in-process windows are held right now. */
export function memoryWindowCount(): number {
  return memWindows.size;
}

/**
 * STEP-UP RE-AUTHENTICATION for money-moving and security-changing panel
 * actions (withdrawals, admin credits, backup restore, key rotation, freeze
 * release).
 *
 * The admin proves who they are again with their password
 * (POST /panel/auth/reauth), which stamps `admin:stepup:<id>` in Redis for
 * `admin_step_up_minutes`. This guard just checks the stamp.
 *
 * If Redis is unreachable the guard FAILS CLOSED (503, with an honest message):
 * unlike a rate limit, this is an authorisation control, and "we could not
 * check so we let it through" is how a single stolen panel session becomes a
 * payout. The window is short, so the operator impact is a retry.
 */
export async function requireStepUp(request: FastifyRequest): Promise<void> {
  const { getNumericSetting } = await import('../services/settings');
  const windowMinutes = await getNumericSetting('admin_step_up_minutes', 15, { min: 0 });
  if (!windowMinutes) return; // feature disabled by the operator
  const admin = request.admin;
  if (!admin)
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Admin authentication required');
  let stampedAt: number | null = null;
  try {
    const raw = await redis.get(`admin:stepup:${admin.id}`);
    stampedAt = raw ? Number(raw) : null;
  } catch {
    throw new AppError(
      ERROR_CODES.AUTH_STEP_UP_REQUIRED,
      503,
      'Cannot verify your re-authentication right now — please try again in a moment'
    );
  }
  if (!stepUpFresh(stampedAt, { windowMinutes })) {
    throw new AppError(ERROR_CODES.AUTH_STEP_UP_REQUIRED, 403, stepUpMessage(windowMinutes));
  }
}

export async function rateLimit(
  request: FastifyRequest,
  key: LimitKey,
  subject: string
) {
  // D-081: FAIL-OPEN — a Redis hiccup must never turn into a 500 that blocks
  // login/signup/money actions. Rate limiting is anti-abuse, not an auth
  // boundary; if Redis is down we log and allow through (availability wins).
  let { windowSec, max } = LIMITS[key];
  if (key === 'deposit') {
    // v1.4.0 (operator request 2026-08-25): the admin decides after HOW LONG
    // the 2nd payment request may be made — window is expressed in SECONDS,
    // count in requests per window. Settings with code defaults as the
    // fail-safe (getNumericSetting never throws; unreachable → default).
    // 5 per 3600s is the shipped default = the old behaviour.
    const { getNumericSetting } = await import('../services/settings');
    windowSec = await getNumericSetting('deposit_rate_window_sec', windowSec, {
      min: 1,
    });
    max = await getNumericSetting('deposit_rate_max', max, { min: 1 });
  }
  let count: number;
  const rlKey = `rl:${key}:${subject}`;
  try {
    count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, windowSec);
  } catch (e) {
    logRedisIssue(`rate-limit:${key}`, e);
    // REDIS IS DOWN — what happens next is an operator decision.
    //
    // This used to be an unconditional `return` (fail-open), so a Redis outage
    // silently switched every limit off: the exact moment a platform is most
    // attractive to a flood was the moment it stopped defending itself.
    //
    //   memory (default) — keep limiting from this process's own window
    //   open             — the old behaviour, for an operator who needs it
    //   closed           — refuse every rate-limited action until Redis returns
    //
    // The default keeps protection in place without an outage of its own.
    const { getSetting } = await import('../services/settings');
    let mode: ReturnType<typeof normalizeFailMode> = 'memory';
    try {
      mode = normalizeFailMode(await getSetting<string>('rate_limit_fail_mode'));
    } catch {
      /* settings unreachable — the safe default stands */
    }
    void import('../services/monitoring')
      .then((m) => {
        m.bumpCounter('limiterFallbacks');
        return m.alert.limiterStoreDown((e as Error).message);
      })
      .catch(() => undefined);
    if (mode === 'open') return;
    if (mode === 'closed')
      throw new AppError(
        ERROR_CODES.GEN_RATE_LIMITED,
        429,
        'The platform is busy right now — please try again in a moment'
      );
    count = memoryIncrement(rlKey, windowSec);
  }
  if (count > max) {
    let retryAfter = windowSec;
    try {
      retryAfter = await redis.ttl(`rl:${key}:${subject}`);
    } catch {
      /* best effort */
    }
    void import('../services/monitoring')
      .then((m) => m.bumpCounter('rateLimited'))
      .catch(() => undefined);
    // seconds-first copy: sub-minute windows must not tell players "0 minutes"
    throw new AppError(
      ERROR_CODES.GEN_RATE_LIMITED,
      429,
      retryAfter < 60
        ? `Too many attempts — please wait ${Math.max(1, Math.ceil(retryAfter))} second(s)`
        : `Too many attempts — please wait ${Math.ceil(retryAfter / 60)} minute(s)`,
      { retryAfter }
    );
  }
}
export const rateLimitFactory =
  (key: LimitKey, subjectFn: (req: FastifyRequest) => string) =>
  async (request: FastifyRequest) =>
    rateLimit(request, key, subjectFn(request));

// ── RESPONSIBLE PLAY (operator toggle D-043 — enforced ONLY when the admin
//    setting `responsible_play_enabled` is true; OFF by default, D-042) ─────

/** H-17: cooling-off horizon for limit raises/removals. */
export const RESP_LIMIT_COOLING_OFF_MS = 24 * 60 * 60 * 1000;

/**
 * H-17: apply any matured pending limit changes (24h+ old). Safe inside or
 * outside a transaction; never throws.
 */
export async function applyMaturedPendingLimits(
  userId: string,
  tx?: PrismaTransactionLike
): Promise<void> {
  const db = tx ?? prisma;
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      pendingLossLimit: true,
      pendingLossLimitAt: true,
      pendingDepositLimit: true,
      pendingDepositLimitAt: true,
    },
  });
  if (!u) return;
  const now = Date.now();
  const data: Record<string, unknown> = {};
  if (
    u.pendingLossLimitAt &&
    now - u.pendingLossLimitAt.getTime() >= RESP_LIMIT_COOLING_OFF_MS
  ) {
    data.dailyLossLimit = u.pendingLossLimit; // may be null = removal
    data.pendingLossLimit = null;
    data.pendingLossLimitAt = null;
  }
  if (
    u.pendingDepositLimitAt &&
    now - u.pendingDepositLimitAt.getTime() >= RESP_LIMIT_COOLING_OFF_MS
  ) {
    data.dailyDepositLimit = u.pendingDepositLimit;
    data.pendingDepositLimit = null;
    data.pendingDepositLimitAt = null;
  }
  if (Object.keys(data).length > 0) {
    // H-17: NOT swallowed. A matured limit that silently failed to apply left
    // the player on their OLD limit with no signal anywhere — the operator
    // believed the cooling-off change had taken effect.
    await db.user
      .update({ where: { id: userId }, data })
      .catch((error: unknown) =>
        console.error(
          `[responsible-play] could not apply matured pending limits for ${userId}:`,
          (error as Error).message
        )
      );
  }
}

type PrismaTransactionLike = {
  user: any;
  gameRound: any;
  sharedRoundBet: any;
  $queryRaw: any;
};

/**
 * H-17: transaction-native daily-loss guard.
 *
 * The HTTP-layer guard (below) checks totals BEFORE the bet, outside any
 * serialization — N concurrent bets each passed it before any settled, and
 * unsettled PLACED/PENDING stakes never counted at all. This variant runs
 * INSIDE the staking transaction, locks the user row FOR UPDATE (so limit
 * decisions serialize with stake acceptance per user), and counts the day's
 * UNSETTLED exposure too: a player cannot stack WinGo periods + a crash bet +
 * a session round past their loss limit anymore.
 */
export async function responsiblePlayTxCheck(
  tx: PrismaTransactionLike,
  userId: string,
  nextStake: number
): Promise<void> {
  // Serialize per user: every stake-accepting tx row-locks the same User row.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  await applyMaturedPendingLimits(userId, tx);
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { dailyLossLimit: true },
  });
  const limit = user?.dailyLossLimit;
  if (!limit) return;
  const start = startOfDay();
  const [settled, pendingRounds, pendingShared] = await Promise.all([
    tx.gameRound.aggregate({
      where: {
        userId,
        demo: false,
        result: { not: 'PENDING' },
        createdAt: { gte: start },
      },
      _sum: { betAmount: true, payoutAmount: true },
    }),
    tx.gameRound.aggregate({
      where: { userId, demo: false, result: 'PENDING', createdAt: { gte: start } },
      _sum: { betAmount: true },
    }),
    tx.sharedRoundBet.aggregate({
      where: {
        userId,
        status: { in: ['PLACED', 'SETTLING'] },
        createdAt: { gte: start },
      },
      _sum: { amount: true },
    }),
  ]);
  const settledLoss =
    Number(settled._sum.betAmount ?? 0) - Number(settled._sum.payoutAmount ?? 0);
  const openExposure =
    Number(pendingRounds._sum.betAmount ?? 0) + Number(pendingShared._sum.amount ?? 0);
  if (settledLoss + openExposure + nextStake > Number(limit)) {
    throw new AppError(
      ERROR_CODES.RESP_DAILY_LOSS_LIMIT,
      403,
      "Daily loss limit reached (today's losses + open bets would exceed it). Come back tomorrow."
    );
  }
}

// ── RESPONSIBLE PLAY (operator toggle D-043 — enforced ONLY when the admin
//    setting `responsible_play_enabled` is true; OFF by default, D-042) ─────
export async function responsiblePlayGuard(userId: string) {
  // H-17: settle matured cooling-off changes before ANY limit is read.
  await applyMaturedPendingLimits(userId);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'User not found');
  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    throw new AppError(
      ERROR_CODES.RESP_SELF_EXCLUDED,
      403,
      'Your self-exclusion is active'
    );
  }
  if (user.status !== 'ACTIVE')
    throw new AppError(
      ERROR_CODES.AUTH_ACCOUNT_SUSPENDED,
      403,
      'Account is not active'
    );
  // Daily loss is derived from durable settled rounds. The old Redis counter
  // was fire-and-forget after settlement, disappeared on Redis loss, and could
  // lag enough to allow more bets after the limit had already been reached.
  if (user.dailyLossLimit) {
    const start = startOfDay();
    const totals = await prisma.gameRound.aggregate({
      where: {
        userId,
        demo: false,
        result: { not: 'PENDING' },
        createdAt: { gte: start },
      },
      _sum: { betAmount: true, payoutAmount: true },
    });
    const lost =
      Number(totals._sum.betAmount ?? 0) - Number(totals._sum.payoutAmount ?? 0);
    if (lost >= Number(user.dailyLossLimit)) {
      throw new AppError(
        ERROR_CODES.RESP_DAILY_LOSS_LIMIT,
        403,
        'Daily loss limit reached. Come back tomorrow.'
      );
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function extractBearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
function extractCookie(req: FastifyRequest, name: string): string | undefined {
  return req.cookies?.[name];
}
