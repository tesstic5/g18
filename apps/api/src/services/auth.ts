// apps/api/src/services/auth.ts — signup/login/refresh rotation/fingerprint.
// Canonical: docs/19 §4, docs/14 (RS256, 15m/7d, rotation + family invalidation).
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  checkPassword,
  lockoutDecision,
  lockoutMessage,
  newDeviceBlocked,
  newDeviceBlockMessage,
  onFailedAttempt,
  lockoutEntryIsLive,
  sessionVersionMatches,
} from './securityPolicy';
import { getNumericSetting, getSetting } from './settings';
import { bumpCounter, raiseAlert } from './monitoring';
import { prisma } from '../db/prisma';
import { applyBalanceChange } from './wallet';
import { redis } from '../db/redis';
import { AppError } from '../lib/core';
import { getJwtPrivateKey, getJwtPublicKey } from '../lib/jwt-keys';
import {
  JWT_ISSUER_USER,
  JWT_ISSUER_REFRESH,
  JWT_ROLE_USER,
  JWT_ROLE_REFRESH,
} from '../lib/jwt-claims';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import { normalizePhone } from '@casino/shared/utils/phone';

const RS256_PRIVATE = () => getJwtPrivateKey(); // RS256 asymmetric (docs/14)
const ACCESS_TTL: jwt.SignOptions['expiresIn'] = (process.env.JWT_ACCESS_EXPIRY ||
  '15m') as jwt.SignOptions['expiresIn'];
const REFRESH_TTL_SEC = 7 * 24 * 3600;

export interface Fingerprint {
  userAgent: string;
  screenRes: string;
  timezone: string;
  language: string;
}
export function hashFingerprint(f: Fingerprint): string {
  return crypto
    .createHash('sha256')
    .update(`${f.userAgent}|${f.screenRes}|${f.timezone}|${f.language}`)
    .digest('hex');
}

export async function signup(input: {
  phone: string;
  password: string;
  displayName?: string;
  fingerprint: Fingerprint;
  referralCode?: string;
}) {
  // D-083: accept any phone format (0300…, +92…, 92…, 300…) → canonical +92…
  const phone = normalizePhone(input.phone) ?? input.phone.trim();

  // SECURITY HARDENING: the old rule was "8 characters", which accepted
  // 12345678 — and on a phone-only platform that is exactly what people pick.
  // Same policy object as change-password and the recovery reset, so no door
  // is weaker than the others.
  const policy = await loadPasswordPolicy();
  const check = checkPassword(input.password, {
    ...policy,
    phone,
    displayName: input.displayName ?? null,
  });
  if (!check.ok)
    throw new AppError(check.code ?? ERROR_CODES.AUTH_PASSWORD_WEAK, 422, check.reason!);

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing)
    throw new AppError(
      ERROR_CODES.AUTH_PHONE_TAKEN,
      409,
      'This phone number is already registered'
    );

  // referral: validate + prevent double-credit (docs/20 rule 8)
  //
  // Codes are stored UPPERCASE (migration 20260901_referral_reward) and the
  // input is normalised the same way, so an invite link resolves however it was
  // re-cased in transit. Previously the lookup was exact, so a link that had
  // been lowercased by a mail client or shortener was rejected outright.
  //
  // An unrecognised code is NOT fatal: losing a new player over a stale or
  // mistyped invite is a worse trade than losing the bonus. We record the
  // attempt and let the registration through without a referrer.
  let referredById: string | undefined;
  let referralApplied = false;
  const rawCode = input.referralCode?.trim();
  if (rawCode) {
    // Codes are stored UPPERCASE, but fall back to the raw input so a legacy
    // mixed/lowercase code (e.g. an old cuid default) still resolves.
    const referrer =
      (await prisma.user.findUnique({
        where: { referralCode: rawCode.toUpperCase() },
      })) ??
      (rawCode.toUpperCase() !== rawCode
        ? await prisma.user.findUnique({ where: { referralCode: rawCode } })
        : null);
    if (referrer) {
      referredById = referrer.id;
      referralApplied = true;
    } else {
      console.warn('[referral] signup with unknown code, continuing without referrer');
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        phone,
        passwordHash: await bcrypt.hash(input.password, 12),
        displayName: input.displayName?.slice(0, 24),
        fingerprintHash: hashFingerprint(input.fingerprint),
        referredById,
        referralCode: crypto.randomBytes(6).toString('hex').toUpperCase(),
      },
    });
    await tx.wallet.create({ data: { userId: created.id } });

    // Per-agent referee SIGNUP bonus: if the referrer is a referral agent with
    // a signup bonus enabled, credit the new player's BONUS wallet right away
    // (playable, not withdrawable). Separate from the wager-triggered bonus.
    // BEST-EFFORT: a bonus problem must NEVER fail the signup itself.
    if (referredById) {
      try {
        const referrer = await tx.user.findUnique({
          where: { id: referredById },
          select: { isReferralAgent: true, referralSignupBonusEnabled: true, referralSignupBonusAmount: true },
        });
        const bonus = referrer?.isReferralAgent && referrer.referralSignupBonusEnabled
          ? new Decimal(referrer.referralSignupBonusAmount.toString())
          : new Decimal(0);
        if (bonus.gt(0)) {
          await applyBalanceChange(created.id, 'BONUS', bonus, 'BONUS_REFERRAL', {
            referenceType: 'referral-signup',
            referenceId: referredById,
            description: 'Referral agent signup bonus',
          }, tx);
        }
      } catch (e) {
        console.warn('[referral] signup bonus skipped:', (e as Error).message);
      }
    }
    // seed pair generated automatically (docs/19 §4)
    const serverSeed = PROVABLY_FAIR.generateServerSeed();
    await tx.seedPair.create({
      data: {
        userId: created.id,
        serverSeed,
        serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
        clientSeed: crypto.randomBytes(8).toString('hex'),
      },
    });
    return created;
  });

  // Admin-configurable WELCOME BONUS. Credited to the BONUS wallet (not REAL),
  // so it must be wagered rather than withdrawn straight back out. Goes through
  // applyBalanceChange for the version bump + ledger row, same as every other
  // credit — a bare wallet.update would make it invisible in history.
  {
    const settings = await getSettings();
    if (settings.signup_bonus_enabled === true) {
      const welcome = new Decimal(Number(settings.signup_bonus_amount) || 0);
      if (welcome.gt(0)) {
        await prisma.$transaction(async (tx) => {
          await applyBalanceChange(
            user.id,
            'BONUS',
            welcome,
            'BONUS_SIGNUP',
            {
              referenceType: 'signup',
              referenceId: user.id,
              description: 'Welcome bonus',
            },
            tx
          );
        });
      }
    }
  }

  // NO referral bonus here any more.
  //
  // It used to pay both legs at signup — ₨35 per referred account with no
  // deposit, no wager and no KYC, which made self-referral farming trivially
  // profitable. Payment now fires on the referee's FIRST APPROVED DEPOSIT
  // (see maybeRewardReferral in services/referral.ts, called from the deposit
  // approval transaction). Signup only records who referred whom.
  // Money still moves when real money arrives — not when a phone number does.

  const tokens = await issueTokens(user.id);
  return { ...tokens, referralApplied };
}

export async function login(phone: string, password: string, fingerprint: Fingerprint) {
  const normalized = normalizePhone(phone) ?? phone.trim();
  let user = await prisma.user.findUnique({ where: { phone: normalized } });

  // ── ACCOUNT LOCKOUT (security hardening) ────────────────────────────────
  // The IP limiter cannot see a botnet spraying ONE account from many
  // addresses, and it cannot see a slow, patient credential-stuffing run
  // either. This counts failures against the ACCOUNT.
  //
  // Keyed by the phone the caller typed (hashed), so it also covers attempts
  // on numbers that have no account — otherwise "does this account exist" is
  // answerable by which message comes back.
  const lockKey = `lock:login:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
  const [maxAttempts, lockMinutes] = await Promise.all([
    getNumericSetting('login_max_attempts', 8, { min: 1 }),
    getNumericSetting('login_lock_minutes', 15, { min: 1 }),
  ]);
  const stored = await readLockout(lockKey);
  // A stale or nonsensical entry (clock moved, corrupted value, an entry that
  // long outlived its own lock) must not lock an account that the operator —
  // and the player — believe is fine. Dropping it makes the next evaluation
  // start from a clean slate.
  const live = lockoutEntryIsLive(stored, { maxLockMs: lockMinutes * 60_000 * 4 });
  const lockState = live ? stored : { failures: 0, lockedUntil: null };
  if (!live && stored.lockedUntil) void clearLockout(lockKey);
  const decision = lockoutDecision(lockState, { maxAttempts, lockMinutes });
  if (decision.locked) {
    bumpCounter('loginFailures');
    throw new AppError(
      ERROR_CODES.AUTH_ACCOUNT_LOCKED,
      429,
      lockoutMessage(decision.retryAfter),
      { retryAfter: decision.retryAfter }
    );
  }

  // same error for missing user vs wrong password (docs/19 §4 — never reveal which)
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    const next = onFailedAttempt(lockState, { maxAttempts, lockMinutes });
    await writeLockout(lockKey, next, lockMinutes);
    bumpCounter('loginFailures');
    const left = lockoutDecision(next, { maxAttempts, lockMinutes });
    if (left.locked) {
      // Tell the account owner (if the account exists) that it just locked —
      // an unexplained lockout is how a real player ends up filing a ticket
      // instead of understanding what happened.
      if (user) {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: 'system',
            title: 'Sign-in temporarily locked',
            body: `Too many failed sign-in attempts. Try again in ${lockMinutes} minute(s), or use account recovery from the sign-in page.`,
          },
        });
      }
      // One alert per locked account, deduped, so an operator can see a
      // credential-stuffing run building without a mailbox full of noise.
      void raiseAlert({
        kind: 'login.account_locked',
        severity: 'medium',
        message: `Account locked after ${maxAttempts} failed sign-in attempts`,
        data: { phone: normalized.replace(/\d(?=\d{3})/g, '*') },
        dedupeKey: `login.account_locked:${normalized}`,
        dedupeMinutes: 180,
      }).catch(() => undefined);
    }
    throw new AppError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS,
      401,
      'Incorrect phone or password'
    );
  }

  // A correct password clears the failure count.
  await clearLockout(lockKey);

  // Account state is checked HERE, at login — not only later in authMiddleware.
  // Previously a suspended/closed/self-excluded user received valid tokens and
  // then hit a confusing 403 on their next request. Self-exclusion in
  // particular must be a hard stop at the door: it's a responsible-gambling
  // commitment, not a per-request error.
  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    throw new AppError(
      ERROR_CODES.AUTH_SELF_EXCLUDED,
      403,
      'Your self-exclusion is still active. Please contact support if you need help.'
    );
  }
  if (user.status === 'SELF_EXCLUDED') {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', selfExcludedUntil: null },
    });
  }
  if (user.status === 'SUSPENDED') {
    throw new AppError(
      ERROR_CODES.AUTH_ACCOUNT_SUSPENDED,
      403,
      'Your account is suspended. Please contact support.'
    );
  }
  if (user.status === 'CLOSED') {
    throw new AppError(
      ERROR_CODES.AUTH_ACCOUNT_CLOSED,
      403,
      'This account has been closed.'
    );
  }
  // Note: only explicitly-bad states are rejected (above). We deliberately do
  // NOT reject on `status !== 'ACTIVE'`, so that a null/unset status — or a new
  // enum value added later — can never lock the whole userbase out of login.

  // fingerprint anomaly detection (docs/14) + NEW-DEVICE POLICY (hardening)
  //
  // The old behaviour was notify-only, which is useless against someone who
  // already has the password: the owner finds out afterwards. Operators who
  // want the stricter behaviour set `new_device_policy = 'block'`, and the
  // player is then sent through account recovery to clear it.
  const fp = hashFingerprint(fingerprint);
  if (user.fingerprintHash && user.fingerprintHash !== fp) {
    const policy = await getSetting<string>('new_device_policy');
    const knownDevices = await prisma.userDevice.count({ where: { userId: user.id } });
    const isKnownDevice = knownDevices
      ? (await prisma.userDevice.findFirst({
          where: { userId: user.id, fingerprintHash: fp },
          select: { id: true },
        })) !== null
      : false;
    if (newDeviceBlocked(policy, { knownDeviceCount: knownDevices, isKnownDevice })) {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'security',
          title: 'Sign-in blocked from a new device',
          body: 'A sign-in attempt from an unrecognised device was blocked by your sign-in policy.',
        },
      });
      void raiseAlert({
        kind: 'login.new_device_blocked',
        severity: 'medium',
        message: 'A sign-in was blocked by the new-device policy',
        data: { userId: user.id },
        dedupeKey: `login.new_device_blocked:${user.id}`,
        dedupeMinutes: 60,
        email: true,
      }).catch(() => undefined);
      throw new AppError(ERROR_CODES.AUTH_ACCOUNT_LOCKED, 403, newDeviceBlockMessage());
    }
    // notify user; do not block (anomaly alert)
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'system',
        title: 'New device login',
        body: 'We noticed a login from a new device. If this was you, ignore this message.',
      },
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), fingerprintHash: user.fingerprintHash || fp },
  });
  return issueTokens(user.id);
}

/** Access (15m) + refresh (7d, httpOnly) with rotation + family invalidation (docs/14). */
export async function issueTokens(userId: string, parentFamily?: string) {
  const family = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
  // `sv` (session version) rides on BOTH tokens and is checked on every
  // request, so "sign out everywhere" cannot be outlived by a live access token.
  const sv = await currentSessionVersion(userId);
  const access = jwt.sign({ sub: userId, role: JWT_ROLE_USER, sv }, RS256_PRIVATE(), {
    algorithm: 'RS256',
    expiresIn: ACCESS_TTL,
    issuer: JWT_ISSUER_USER,
  });
  // Distinct issuer + role: a refresh token must never be accepted as an
  // access token by authMiddleware (which now asserts issuer=casino, role=user).
  const refresh = jwt.sign(
    { sub: userId, fam: family, role: JWT_ROLE_REFRESH, sv },
    RS256_PRIVATE(),
    {
      algorithm: 'RS256',
      expiresIn: '7d',
      issuer: JWT_ISSUER_REFRESH,
    }
  );

  // DURABLE record in Postgres. This write is REQUIRED — if it fails we do not
  // hand out a token, because a token we cannot later revoke is worse than a
  // failed login. (Previously this lived only in Redis and was fail-open.)
  await prisma.refreshTokenFamily.create({
    data: { id: family, userId, expiresAt, parentId: parentFamily ?? null },
  });

  // Redis is now only a read-through cache to keep the hot path fast.
  try {
    await redis.set(
      `refresh_token:${family}`,
      JSON.stringify({ userId, used: false }),
      'EX',
      REFRESH_TTL_SEC
    );
  } catch {
    /* cache-only: Postgres already has the durable record */
  }
  return { accessToken: access, refreshToken: refresh, family };
}

/** Revoke a family and every token rotated from it (theft response). */
async function revokeFamilyChain(familyId: string, reason: string): Promise<void> {
  // Walk forward through the rotation chain: revoking a stolen token must also
  // kill the descendants an attacker may already have rotated into.
  const ids: string[] = [];
  let cursor: string | null = familyId;
  for (let i = 0; cursor && i < 100; i++) {
    ids.push(cursor);
    const next: { replacedById: string | null } | null =
      await prisma.refreshTokenFamily.findUnique({
        where: { id: cursor },
        select: { replacedById: true },
      });
    cursor = next?.replacedById ?? null;
  }
  await prisma.refreshTokenFamily.updateMany({
    where: { id: { in: ids }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  for (const id of ids) {
    try {
      await redis.del(`refresh_token:${id}`);
    } catch {
      /* cache best-effort */
    }
  }
}

/**
 * Refresh with rotation: the old family is marked used; reuse of a used family
 * invalidates the whole family (theft detection).
 *
 * (Removed a dead `usedFamily` parameter — no caller ever passed it, so the
 * "suspected theft" branch was unreachable. Reuse detection is handled below,
 * where the stored family record is actually inspected.)
 */
export async function refreshTokens(oldRefresh: string) {
  // Verify with the PUBLIC key and assert the refresh issuer so an access token
  // can never be replayed here.
  const payload = jwt.verify(oldRefresh, getJwtPublicKey(), {
    algorithms: ['RS256'],
    issuer: JWT_ISSUER_REFRESH,
  }) as { sub: string; fam: string; sv?: number };

  // Postgres is the source of truth — this check ALWAYS runs, including during
  // a Redis outage. A stolen token is therefore never replayable.
  const family = await prisma.refreshTokenFamily.findUnique({
    where: { id: payload.fam },
  });
  if (!family)
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Session expired');
  if (family.userId !== payload.sub) {
    // Token claims a different user than the family was issued to.
    await revokeFamilyChain(payload.fam, 'user_mismatch');
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Session revoked');
  }
  if (family.revokedAt)
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Session revoked');
  // SESSION VERSION: a refresh token minted before a logout-all / password
  // change must not resurrect the session it belongs to.
  const currentSv = await currentSessionVersion(payload.sub);
  if (!sessionVersionMatches(payload.sv, currentSv))
    throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'Session revoked');
  void redis; // (cache handled below)
  if (family.expiresAt <= new Date())
    throw new AppError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 401, 'Session expired');
  if (family.usedAt) {
    // A second tab can submit the old cookie while the first tab is rotating it.
    // That request receives no token, but it must not revoke the legitimate new
    // family. During a short grace window return a retryable conflict; genuine
    // later reuse still revokes the chain as theft response.
    const ageMs = Date.now() - family.usedAt.getTime();
    if (ageMs < 15_000) {
      throw new AppError(
        'AUTH_REFRESH_RACE',
        409,
        'Session was refreshed in another tab — retry'
      );
    }
    await revokeFamilyChain(payload.fam, 'reuse_detected');
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Session revoked — please sign in again'
    );
  }

  // H-04: claim parent + create child + LINK both in ONE Postgres transaction.
  // Before, the descendant family row was created first and the chain link was
  // patched afterwards with a swallowed catch — a link failure left an
  // unlinked descendant that family revocation could never reach (fail-open
  // theft response). Now either the whole rotation is durable and linked, or
  // nothing happens and NO token is signed below.
  const newFamilyId = crypto.randomUUID();
  const childExpiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
  const txResult = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshTokenFamily.updateMany({
      where: { id: payload.fam, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return { claimed: 0 };
    await tx.refreshTokenFamily.create({
      data: {
        id: newFamilyId,
        userId: payload.sub,
        expiresAt: childExpiresAt,
        parentId: payload.fam,
      },
    });
    await tx.refreshTokenFamily.update({
      where: { id: payload.fam },
      data: { replacedById: newFamilyId },
    });
    return { claimed: 1 };
  });
  if (txResult.claimed !== 1) {
    // Lost a legitimate same-browser/tab race. Do not revoke the winner's new
    // family; the caller retries after the Set-Cookie from that winner lands.
    const latest = await prisma.refreshTokenFamily.findUnique({
      where: { id: payload.fam },
    });
    if (latest?.usedAt && Date.now() - latest.usedAt.getTime() < 15_000) {
      throw new AppError(
        'AUTH_REFRESH_RACE',
        409,
        'Session was refreshed in another tab — retry'
      );
    }
    await revokeFamilyChain(payload.fam, 'concurrent_use');
    throw new AppError(
      ERROR_CODES.AUTH_TOKEN_INVALID,
      401,
      'Session revoked — please sign in again'
    );
  }

  // The chain + new family row are durable (transaction above). NOW sign
  // the tokens against the already-created family. If signing throws, the
  // orphan child row is inert — it never entered a cookie.
  const access = jwt.sign({ sub: payload.sub, role: JWT_ROLE_USER, sv: currentSv }, RS256_PRIVATE(), {
    algorithm: 'RS256',
    expiresIn: ACCESS_TTL,
    issuer: JWT_ISSUER_USER,
  });
  const refresh = jwt.sign(
    { sub: payload.sub, fam: newFamilyId, role: JWT_ROLE_REFRESH, sv: currentSv },
    RS256_PRIVATE(),
    { algorithm: 'RS256', expiresIn: '7d', issuer: JWT_ISSUER_REFRESH }
  );
  try {
    await redis.set(
      `refresh_token:${newFamilyId}`,
      JSON.stringify({ userId: payload.sub, used: false }),
      'EX',
      REFRESH_TTL_SEC
    );
    await redis.del(`refresh_token:${payload.fam}`);
  } catch {
    /* caches best-effort — Postgres is authoritative */
  }
  return { accessToken: access, refreshToken: refresh, family: newFamilyId };
}

export async function logout(family?: string) {
  if (!family) return;
  // Durable revocation — a logged-out token must stay dead even if Redis is
  // wiped or restarted.
  await revokeFamilyChain(family, 'logout');
}

/** Revoke every active session for a user (password change, admin ban, support). */
export async function revokeAllSessions(
  userId: string,
  reason = 'revoke_all'
): Promise<number> {
  const result = await prisma.refreshTokenFamily.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  // Kill the ACCESS tokens too: revoking refresh families only stops renewal,
  // so a copied access token used to keep working for up to 15 minutes.
  await bumpSessionVersion(userId);
  return result.count;
}

// ── SESSION VERSION (security hardening) ───────────────────────────────────

/** Current session version of a player (0 when the row predates the column). */
export async function currentSessionVersion(userId: string): Promise<number> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  return row?.sessionVersion ?? 0;
}

/** Invalidate every access/refresh token already issued for this player. */
export async function bumpSessionVersion(userId: string): Promise<number> {
  const row = await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });
  return row.sessionVersion;
}



/** Housekeeping: drop long-expired rows so the table doesn't grow forever. */
export async function purgeExpiredSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  const result = await prisma.refreshTokenFamily.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}

async function getSettings(): Promise<Record<string, unknown>> {
  const all = await prisma.setting.findMany();
  return Object.fromEntries(all.map((s) => [s.key, s.value as unknown]));
}

// ── SECURITY HARDENING HELPERS ─────────────────────────────────────────────

/** The password rules as configured by the operator (with code defaults). */
export async function loadPasswordPolicy(): Promise<{
  minLength: number;
  rejectCommon: boolean;
}> {
  const [minLength, rejectCommon] = await Promise.all([
    getNumericSetting('password_min_length', 8, { min: 8 }),
    getSetting<boolean>('password_reject_common'),
  ]);
  return { minLength, rejectCommon: rejectCommon !== false };
}

/**
 * Lockout state lives in Redis (fast, per-account, self-expiring) — but must
 * not become a way IN if Redis is down: a read failure is treated as "no
 * failures recorded", which is the same exposure as before this feature
 * existed (the IP limiter still applies).
 */
export async function readLockout(
  key: string
): Promise<{ failures: number; lockedUntil: number | null }> {
  try {
    const raw = await redis.get(key);
    if (!raw) return { failures: 0, lockedUntil: null };
    const parsed = JSON.parse(raw) as { failures?: number; lockedUntil?: number | null };
    return {
      failures: Number(parsed.failures ?? 0),
      lockedUntil: parsed.lockedUntil ?? null,
    };
  } catch {
    return { failures: 0, lockedUntil: null };
  }
}

export async function writeLockout(
  key: string,
  state: { failures: number; lockedUntil: number | null },
  lockMinutes: number
): Promise<void> {
  try {
    // Keep the counter for the lock window, so a lockout cannot be outlived by
    // simply waiting out the counter's TTL.
    const ttl = Math.max(lockMinutes, 15) * 60;
    await redis.set(key, JSON.stringify(state), 'EX', ttl);
  } catch {
    /* fail-soft: the IP limiter still stands between an attacker and the account */
  }
}

export async function clearLockout(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* ignore */
  }
}

/** Add a hash to the user's password history, trimmed to the configured depth. */
export async function recordPasswordHistory(
  userId: string,
  passwordHash: string,
  depth: number
): Promise<void> {
  await prisma.passwordHistory.create({ data: { userId, passwordHash } });
  if (depth <= 0) return;
  const stale = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: depth,
    select: { id: true },
  });
  if (stale.length)
    await prisma.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

/** True when `candidate` matches one of the last `depth` hashes. */
export async function isPasswordReused(
  userId: string,
  candidate: string,
  depth: number
): Promise<boolean> {
  if (depth <= 0) return false;
  const history = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: depth,
    select: { passwordHash: true },
  });
  for (const row of history) {
    if (await bcrypt.compare(candidate, row.passwordHash)) return true;
  }
  return false;
}
