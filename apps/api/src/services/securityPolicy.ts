// apps/api/src/services/securityPolicy.ts
//
// SECURITY POLICY — the pure rules behind every hardening control added after
// the security inventory. No database, no Redis, no Fastify: routes and
// middleware own persistence, this module owns the decisions, so each rule can
// be unit-tested without a stack (same split as services/recovery.ts).
//
// Covers:
//   • password strength (length, trivially-guessable shapes, phone reuse)
//   • account lockout after repeated failed logins
//   • dual control (two-person approval) on money movements
//   • admin session idle timeout + step-up freshness window
//   • new-device policy (notify / block)
//   • what the rate limiter does when its store is unavailable

// ── Passwords ──────────────────────────────────────────────────────────────
/** Absolute floor/ceiling, independent of the admin-tunable minimum. */
export const PASSWORD_HARD_MIN = 8;
export const PASSWORD_HARD_MAX = 72; // bcrypt truncates past 72 bytes

/**
 * The passwords that actually get used on real platforms. Kept deliberately
 * short and readable rather than shipping a 100k list: this is a floor, not a
 * strength meter, and every entry here is one an operator would recognise.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'admin123',
  'administrator',
  'letmein123',
  'welcome123',
  'welcome1',
  'abc123456',
  'a1234567',
  'test1234',
  'changeme',
  'pakistan',
  'pakistan123',
  'karachi123',
  'lahore123',
  'jazzcash',
  'easypaisa',
  'casino123',
  'gambler123',
  'player123',
  '11111111',
  '00000000',
  '12121212',
  '88888888',
  '987654321',
  '11223344',
  'asdfghjkl',
  'zxcvbnm123',
  '1q2w3e4r',
  '1qaz2wsx',
] as const;

/** Rough entropy proxy: distinct characters carry far more than repeated ones. */
export function characterVariety(password: string): number {
  return new Set(password).size;
}

export interface PasswordPolicyOptions {
  minLength?: number;
  rejectCommon?: boolean;
  /** The player's own phone (any format) — reusing it must never be allowed. */
  phone?: string | null;
  displayName?: string | null;
}

export interface PasswordCheck {
  ok: boolean;
  reason?: string;
  code?: 'AUTH_PASSWORD_WEAK';
}

/** Digits only — mirrors the digits in `normalizePhone` for the reuse check. */
function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/**
 * Validate a NEW password. Signup, change-password and the recovery reset all
 * route through here so a weak password cannot enter through the newest door
 * (the recovery flow was added after the original signup validation).
 */
export function checkPassword(
  password: unknown,
  opts: PasswordPolicyOptions = {}
): PasswordCheck {
  const min = Math.max(
    PASSWORD_HARD_MIN,
    Math.min(Math.floor(Number(opts.minLength ?? PASSWORD_HARD_MIN)) || PASSWORD_HARD_MIN, 32)
  );
  const weak = (reason: string): PasswordCheck => ({
    ok: false,
    reason,
    code: 'AUTH_PASSWORD_WEAK',
  });

  if (typeof password !== 'string' || password.length === 0)
    return weak('Enter a password');
  if (password.length < min) return weak(`Password must be at least ${min} characters`);
  if (password.length > PASSWORD_HARD_MAX)
    return weak(`Password must be ${PASSWORD_HARD_MAX} characters or fewer`);
  if (password.trim().length !== password.length)
    return weak('Password cannot start or end with a space');

  const lower = password.toLowerCase();
  if (opts.rejectCommon !== false && COMMON_PASSWORDS.includes(lower))
    return weak('That password is one of the most commonly used ones — pick something else');

  // A password of only digits is a PIN, and it is the shape a phone-only signup
  // invites. Two character classes minimum.
  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
  if (/^[0-9]+$/.test(password)) return weak('Password cannot be only numbers');
  if (classes < 2)
    return weak('Password needs at least two of: letters, numbers, symbols');
  if (characterVariety(password) < 4)
    return weak('Password repeats too few different characters');

  // Never let the account's own phone number be the password (all formats).
  const phoneDigits = digitsOf(String(opts.phone ?? ''));
  if (phoneDigits.length >= 6) {
    const tail = phoneDigits.slice(-10);
    const pwDigits = digitsOf(password);
    if (pwDigits.length >= 6 && (pwDigits.includes(tail) || tail.includes(pwDigits)))
      return weak('Password cannot be your mobile number');
  }
  const name = String(opts.displayName ?? '').trim().toLowerCase();
  // Squash non-alphanumerics on BOTH sides: "Imran Khan" must also catch
  // "imran-khan-91", which is how people actually type a name into a password.
  const squash = (value: string) => value.replace(/[^a-z0-9]/g, '');
  if (name.length >= 4 && (lower.includes(name) || squash(lower).includes(squash(name))))
    return weak('Password cannot be your display name');

  return { ok: true };
}

// Password-reuse prevention is implemented in the routes (bcrypt compare is
// async): see auth.changePassword, which checks the candidate against the last
// `password_history_depth` hashes before accepting it.

// ── Account lockout ────────────────────────────────────────────────────────
export interface LockoutState {
  failures: number;
  lockedUntil: number | null;
}

export interface LockoutDecision {
  locked: boolean;
  /** Seconds remaining, for the Retry-After style message. */
  retryAfter: number;
  /** Failures left before the account locks (0 once locked). */
  remaining: number;
}

/**
 * Decide from the recorded failure count whether an account is locked right
 * now, and how many more failures it has. Pure arithmetic so the login route
 * only has to read/write Redis.
 */
export function lockoutDecision(
  state: LockoutState,
  opts: { maxAttempts: number; lockMinutes: number; now?: number }
): LockoutDecision {
  const now = opts.now ?? Date.now();
  const max = Math.max(1, Math.floor(opts.maxAttempts));
  const lockMs = Math.max(1, Math.floor(opts.lockMinutes)) * 60_000;
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      locked: true,
      retryAfter: Math.ceil((state.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }
  // A lock timestamp in the PAST means the lock has been served. The failure
  // counter is stale at that point, so the account gets a full slate back —
  // otherwise `failures >= max` would re-lock it on every attempt and the
  // player would stay out until Redis expired the key.
  if (state.lockedUntil) return { locked: false, retryAfter: 0, remaining: max };
  const failures = Math.max(0, state.failures);
  if (failures >= max) {
    // Threshold reached but no explicit lock timestamp (older counter) — the
    // lock starts now rather than letting the next attempt through.
    return { locked: true, retryAfter: Math.ceil(lockMs / 1000), remaining: 0 };
  }
  return { locked: false, retryAfter: 0, remaining: max - failures };
}

/** The state to persist after a failed attempt. */
export function onFailedAttempt(
  state: LockoutState,
  opts: { maxAttempts: number; lockMinutes: number; now?: number }
): LockoutState {
  const now = opts.now ?? Date.now();
  // Failures recorded under a lock that has already been served are spent:
  // counting them again would re-lock the account on a single mistyped
  // password long after the player waited the lockout out.
  const servedLock = Boolean(state.lockedUntil && state.lockedUntil <= now);
  const failures = (servedLock ? 0 : Math.max(0, state.failures)) + 1;
  const max = Math.max(1, Math.floor(opts.maxAttempts));
  if (failures >= max) {
    return { failures, lockedUntil: now + Math.max(1, Math.floor(opts.lockMinutes)) * 60_000 };
  }
  return { failures, lockedUntil: null };
}

/** Message shown to a locked-out player. Never says whether the phone exists. */
export function lockoutMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return (
    `Too many failed sign-in attempts on this account. ` +
    `Try again in ${minutes} minute(s), or recover your account from the sign-in page.`
  );
}

// ── Dual control ───────────────────────────────────────────────────────────
export interface DualControlInput {
  amount: number;
  threshold: number;
  /** Admin who already approved the FIRST leg, if any. */
  firstApproverId?: string | null;
  approverId: string;
}

export type DualControlState =
  | { stage: 'not-required' }
  | { stage: 'awaiting-first' }
  | { stage: 'awaiting-second'; firstApproverId: string }
  | { stage: 'rejected'; reason: string };

/**
 * Two-person rule for money movements.
 *
 *   threshold <= 0            → single approval (feature off)
 *   amount <  threshold       → single approval
 *   first approval            → recorded, action stays pending
 *   second approval           → must come from a DIFFERENT admin
 *
 * Rejection is deliberately NOT part of this: taking money back or refusing a
 * payout is always safe and must never be blocked behind a second signature.
 */
export function dualControlStage(input: DualControlInput): DualControlState {
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return { stage: 'not-required' };
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) < threshold)
    return { stage: 'not-required' };
  const first = input.firstApproverId ?? null;
  if (!first) return { stage: 'awaiting-first' };
  if (first === input.approverId)
    return {
      stage: 'rejected',
      reason: 'A second admin must approve — you already approved this one',
    };
  return { stage: 'awaiting-second', firstApproverId: first };
}

export function dualControlMessage(amount: number, threshold: number): string {
  return (
    `This amount (${amount}) is at or above the dual-control threshold (${threshold}) — ` +
    'a second admin must approve it before it executes.'
  );
}

// ── Admin session hygiene ──────────────────────────────────────────────────
export interface IdleDecision {
  expired: boolean;
  /** Minutes since the last recorded activity. */
  idleMinutes: number;
}

/** Sliding idle timeout for panel sessions. `timeoutMinutes <= 0` disables it. */
export function idleDecision(
  lastActiveAt: Date | string | number | null | undefined,
  opts: { timeoutMinutes: number; now?: number }
): IdleDecision {
  const now = opts.now ?? Date.now();
  const timeout = Number(opts.timeoutMinutes);
  if (!Number.isFinite(timeout) || timeout <= 0) return { expired: false, idleMinutes: 0 };
  if (!lastActiveAt) return { expired: false, idleMinutes: 0 };
  const last = new Date(lastActiveAt).getTime();
  if (!Number.isFinite(last)) return { expired: false, idleMinutes: 0 };
  const idleMinutes = Math.floor((now - last) / 60_000);
  return { expired: now - last > timeout * 60_000, idleMinutes: Math.max(0, idleMinutes) };
}

/**
 * Step-up freshness. Sensitive actions (payout, credit, restore, key rotation,
 * freeze release) require the admin to have re-entered their password within
 * this window. Redis holds the stamp; a missing stamp is simply "not fresh".
 */
export function stepUpFresh(
  stampedAt: Date | string | number | null | undefined,
  opts: { windowMinutes: number; now?: number }
): boolean {
  const now = opts.now ?? Date.now();
  const window = Number(opts.windowMinutes);
  if (!Number.isFinite(window) || window <= 0) return true; // feature off
  if (!stampedAt) return false;
  const at = new Date(stampedAt).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at <= window * 60_000 && at <= now + 60_000;
}

export function stepUpMessage(windowMinutes: number): string {
  return (
    'Confirm your password to continue — this action moves money or changes security settings. ' +
    `Re-authentication stays valid for ${windowMinutes} minute(s).`
  );
}

// ── New devices ────────────────────────────────────────────────────────────
export type NewDevicePolicy = 'notify' | 'block';

export function normalizeNewDevicePolicy(value: unknown): NewDevicePolicy {
  return value === 'block' ? 'block' : 'notify';
}

/**
 * True when a sign-in from an unseen device must be refused. Only a KNOWN
 * device history counts: an account with no device rows at all (created before
 * device tracking, or restored from an older backup) must never be locked out
 * by this policy — that would turn a hardening feature into an outage.
 */
export function newDeviceBlocked(
  policy: unknown,
  opts: { knownDeviceCount: number; isKnownDevice: boolean }
): boolean {
  if (normalizeNewDevicePolicy(policy) !== 'block') return false;
  if (opts.knownDeviceCount <= 0) return false;
  return !opts.isKnownDevice;
}

export function newDeviceBlockMessage(): string {
  return (
    'Sign-in from a new device is blocked on this account. ' +
    'Use a device you have used before, or recover your account from the sign-in page.'
  );
}

// ── Rate-limit store failure ───────────────────────────────────────────────
export type RateLimitFailMode = 'memory' | 'open' | 'closed';

export function normalizeFailMode(value: unknown): RateLimitFailMode {
  if (value === 'open' || value === 'closed') return value;
  return 'memory';
}

// ── Retention ──────────────────────────────────────────────────────────────
export interface RetentionCutoff {
  days: number;
  /** `null` = purge disabled for this rule. */
  before: Date | null;
}

/**
 * Cutoff instant for a retention rule. `days <= 0` returns `null`, which every
 * caller must read as "purge disabled" — never as "purge everything".
 */
export function retentionCutoff(days: unknown, now = Date.now()): RetentionCutoff {
  const n = Number(days);
  return {
    days: n,
    before: Number.isFinite(n) && n > 0 ? new Date(now - n * 86_400_000) : null,
  };
}

/** Age of a timestamp in days, rounded down (watchdog + monitoring). */
export function ageInDays(at: Date | string | number | null | undefined, now = Date.now()): number {
  if (at === null || at === undefined) return Number.POSITIVE_INFINITY;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - t) / 86_400_000);
}

// ── Session versioning ─────────────────────────────────────────────────────
/**
 * Should an already-issued token still be accepted?
 *
 * Every access/refresh token carries `sv` (the account's session version at
 * mint time). Bumping the account's version — sign out everywhere, password
 * change, recovery reset, admin ban — makes those tokens stale immediately,
 * which is the difference between "the session cannot be renewed" and "the
 * session is over". Tokens minted before this feature have no `sv`, which
 * reads as 0 and matches an account that has never been bumped.
 */
export function sessionVersionMatches(
  tokenSv: unknown,
  current: number | null | undefined
): boolean {
  const stamped = typeof tokenSv === 'number' && Number.isFinite(tokenSv) ? tokenSv : 0;
  return stamped === (current ?? 0);
}

// ── Lockout state hygiene ──────────────────────────────────────────────────
/**
 * Should a stored failure count still count against the account?
 *
 * The lock state lives in Redis with a TTL, but Redis is not always there (a
 * restart with persistence off, a failed failover, an operator flushing keys)
 * and neither is the clock an operator may have moved. Without this check a
 * stale entry that says "locked until <long past>" could sit in the store and,
 * once a future attempt matched the same account, lock it out again — a lockout
 * that outlives its own promise is indistinguishable from a broken account.
 *
 * `lockedUntil` semantics:
 *   null / missing  → no lock recorded; the counter stands
 *   >= now          → an ACTIVE lock
 *   < now           → a lock that has already been served (see lockoutDecision)
 *   far future (> max) → clock skew or a corrupted row; treat as no lock so the
 *                        account is never locked for an unreasonable time
 */
export function lockoutEntryIsLive(
  entry: { lockedUntil?: number | null } | null | undefined,
  opts: { now?: number; maxLockMs?: number } = {}
): boolean {
  if (!entry) return false;
  const until = entry.lockedUntil ?? null;
  if (until === null) return true;
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(until)) return false;
  const maxLockMs = opts.maxLockMs ?? 24 * 3600_000;
  if (until - now > maxLockMs) return false; // absurd timestamp: not a real lock
  // A served lock is still worth keeping only until its TTL does the cleanup —
  // but it must never be read as "currently locked" (that is lockoutDecision's
  // job). Keep it while it is in the past by less than the max window.
  return now - until < maxLockMs;
}
