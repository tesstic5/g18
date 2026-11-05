// apps/api/src/services/recovery.ts
//
// ACCOUNT RECOVERY CONSOLE — the pure rules.
//
// This platform deliberately has no email and no SMS, so "forgot my password"
// cannot be solved with a reset link or an OTP. The flow implemented here is
// agent-mediated instead, and it needs TWO independent secrets to take over an
// account:
//
//   1. the TICKET code — issued when the claimant files a public recovery
//      request and kept by them (they are the only holder of the plaintext;
//      we store a hash). It is how they read the thread and collect the
//      outcome without being able to log in.
//   2. the RECOVERY code — a one-time code generated only after ONE admin has
//      verified the claimant against evidence (>= 3 of 5 checks) and a
//      DIFFERENT super-admin has approved it. It is shown to whoever holds
//      the ticket code, and it is destroyed on first use.
//
// Nothing in this file touches the database: the routes own persistence and
// this module owns the arithmetic, so the rules are unit-testable without a
// DB (same split as services/smtpSettings.ts).

import crypto from 'node:crypto';

// ── Codes ──────────────────────────────────────────────────────────────────
// 30-symbol alphabet: no 0/O, no 1/I/L, no U (reads as V when handwritten).
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const RECOVERY_TICKET_PREFIX = 'TKT';
export const RECOVERY_CODE_PREFIX = 'RVC';
/** Symbols per code body → 30^12 ≈ 5.3e17 (≈2^59) guesses. */
export const RECOVERY_BODY_LENGTH = 12;
export const RECOVERY_GROUP_SIZE = 4;

/** Wrong recovery codes tolerated before the challenge is destroyed. */
export const RECOVERY_MAX_ATTEMPTS = 5;
/** How long a recovery code stays collectable. */
export const RECOVERY_DEFAULT_CODE_TTL_MIN = 30;
/** Default withdrawal freeze applied when a recovery is approved. */
export const RECOVERY_DEFAULT_FREEZE_HOURS = 48;
/** Upper bound a super-admin may set (one week). */
export const RECOVERY_MAX_FREEZE_HOURS = 168;
/** Evidence checks that must match before a request can be approved. */
export const RECOVERY_MIN_CHECKS = 3;

function randomBody(): string {
  let out = '';
  for (let i = 0; i < RECOVERY_BODY_LENGTH; i += 1) {
    // charAt keeps the type `string` under noUncheckedIndexedAccess
    out += RECOVERY_ALPHABET.charAt(crypto.randomInt(0, RECOVERY_ALPHABET.length));
  }
  return out;
}

function group(body: string): string {
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += RECOVERY_GROUP_SIZE) {
    parts.push(body.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return parts.join('-');
}

/**
 * Mint a fresh code. `kind` decides the prefix: a ticket code is held by the
 * claimant for the life of the request, a recovery code is one-time.
 */
export function generateCode(kind: 'ticket' | 'recovery'): string {
  const prefix = kind === 'ticket' ? RECOVERY_TICKET_PREFIX : RECOVERY_CODE_PREFIX;
  return `${prefix}-${group(randomBody())}`;
}

/** Uppercase and drop every separator — "rvc 4f7k-9qx2…" still works. */
export function normalizeCode(input: string): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * True when `input` is a well-formed code of the expected kind. Prefix-aware so
 * a ticket code can never be pasted into the recovery field (or the reverse).
 */
export function isWellFormedCode(input: string, kind: 'ticket' | 'recovery'): boolean {
  const normalized = normalizeCode(input);
  const prefix = kind === 'ticket' ? RECOVERY_TICKET_PREFIX : RECOVERY_CODE_PREFIX;
  if (normalized.length !== prefix.length + RECOVERY_BODY_LENGTH) return false;
  if (!normalized.startsWith(prefix)) return false;
  const body = normalized.slice(prefix.length);
  for (const ch of body) if (!RECOVERY_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * sha256 of the normalized code. These are 59-bit random strings, not
 * passwords, so a fast hash is right: an offline attacker gains nothing from
 * stretching, and the stored value still cannot be replayed in the UI.
 */
export function hashCode(input: string): string {
  return crypto.createHash('sha256').update(normalizeCode(input)).digest('hex');
}

/** Compare two hashes without leaking length/timing (both are hex strings). */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Evidence checklist ─────────────────────────────────────────────────────
export interface EvidenceCheck {
  key: string;
  label: string;
  hint: string;
}

/**
 * The five checks an agent ticks. Every one of them is a fact that lives in
 * OUR database and that a phone-number thief does not have — which is exactly
 * why a phone number may never be the only thing verified.
 */
export const RECOVERY_EVIDENCE: readonly EvidenceCheck[] = [
  {
    key: 'depositRef',
    label: 'Deposit reference number',
    hint: 'Claimant quoted a reference that matches a real deposit on this account.',
  },
  {
    key: 'senderAccount',
    label: 'Deposit sender account',
    hint: 'Matches the sender account recorded on one of their deposits.',
  },
  {
    key: 'payoutAccount',
    label: 'Payout account',
    hint: 'Names a bank / JazzCash / EasyPaisa account once saved on this profile.',
  },
  {
    key: 'deviceHistory',
    label: 'Device or login history',
    hint: 'Described device, city or signup date matches the stored history.',
  },
  {
    key: 'signupTiming',
    label: 'Signup / account detail',
    hint: 'Recalls roughly when they joined, or another detail only the owner would know.',
  },
] as const;

export type RecoveryChecks = Record<string, boolean>;

/** Coerce arbitrary JSON (or form input) into a `{ [key]: boolean }` map. */
export function sanitizeChecks(input: unknown): RecoveryChecks {
  const out: RecoveryChecks = {};
  const src = (input ?? {}) as Record<string, unknown>;
  for (const { key } of RECOVERY_EVIDENCE) out[key] = src[key] === true;
  return out;
}

export function checklistCount(checks: RecoveryChecks | null | undefined): number {
  if (!checks) return 0;
  let n = 0;
  for (const { key } of RECOVERY_EVIDENCE) if (checks[key] === true) n += 1;
  return n;
}

export function checklistPassed(
  checks: RecoveryChecks | null | undefined,
  min: number = RECOVERY_MIN_CHECKS
): boolean {
  return checklistCount(checks) >= min;
}

// ── State machine ──────────────────────────────────────────────────────────
export type RecoveryStatus =
  | 'PENDING'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'APPROVED'
  | 'REDEEMED'
  | 'REJECTED'
  | 'EXPIRED';

export const RECOVERY_STATUSES: readonly RecoveryStatus[] = [
  'PENDING',
  'IN_REVIEW',
  'VERIFIED',
  'APPROVED',
  'REDEEMED',
  'REJECTED',
  'EXPIRED',
] as const;

export function isRecoveryStatus(v: unknown): v is RecoveryStatus {
  return typeof v === 'string' && (RECOVERY_STATUSES as readonly string[]).includes(v);
}

export function statusLabel(status: RecoveryStatus | string): string {
  switch (status) {
    case 'PENDING':
      return 'Submitted';
    case 'IN_REVIEW':
      return 'Under review';
    case 'VERIFIED':
      return 'Verified — awaiting second approval';
    case 'APPROVED':
      return 'Approved — collect your code';
    case 'REDEEMED':
      return 'Completed';
    case 'REJECTED':
      return 'Declined';
    case 'EXPIRED':
      return 'Code expired';
    default:
      return String(status);
  }
}

/** A request whose thread still accepts player messages. */
export function threadOpen(status: RecoveryStatus | string): boolean {
  return status !== 'REJECTED' && status !== 'REDEEMED' && status !== 'EXPIRED';
}

/** Requests an agent still has to act on. */
export function awaitingAgent(status: RecoveryStatus | string): boolean {
  return status === 'PENDING' || status === 'IN_REVIEW';
}

// ── Guards ─────────────────────────────────────────────────────────────────
export interface ApproveGuardInput {
  status: RecoveryStatus | string;
  verifiedBy: string | null | undefined;
  approverId: string;
  isSuperAdmin: boolean;
  redeemedAt?: Date | string | null;
  codeExpiresAt?: Date | string | null;
  now?: number;
}

/**
 * Dual control. Approval is the moment the account changes hands, so it takes:
 *   • a super-admin (managers may only verify), AND
 *   • someone OTHER than the admin who verified the evidence.
 * A re-approval is allowed when the previous code expired — the request stays
 * VERIFIED/APPROVED, so the second admin re-issues rather than re-verifying.
 */
export function approveGuard(input: ApproveGuardInput): { ok: boolean; reason?: string } {
  const now = input.now ?? Date.now();
  const { status } = input;
  if (!input.isSuperAdmin)
    return { ok: false, reason: 'Only a super-admin can approve a recovery' };
  if (input.redeemedAt)
    return { ok: false, reason: 'This request was already completed' };
  if (!input.verifiedBy)
    return { ok: false, reason: 'No verification is on record for this request' };
  if (input.verifiedBy === input.approverId)
    return { ok: false, reason: 'A second admin must approve — you verified this request' };
  if (status === 'VERIFIED') return { ok: true };
  if (status === 'APPROVED') {
    const expired = !input.codeExpiresAt || new Date(input.codeExpiresAt).getTime() <= now;
    if (expired) return { ok: true };
    return { ok: false, reason: 'An unexpired code is already waiting for the player' };
  }
  if (status === 'REJECTED') return { ok: false, reason: 'This request was declined' };
  if (status === 'EXPIRED') {
    // The code was destroyed by failed attempts; the verification still stands,
    // but let a human look at why it failed before re-issuing.
    return { ok: false, reason: 'Code was destroyed after failed attempts — reject and file a new request' };
  }
  if (status === 'REDEEMED') return { ok: false, reason: 'This request was already completed' };
  return { ok: false, reason: 'Evidence has not been verified yet' };
}

export interface RedeemGuardInput {
  status: RecoveryStatus | string;
  codeHash: string | null | undefined;
  codeExpiresAt: Date | string | null | undefined;
  attempts: number;
  now?: number;
  maxAttempts?: number;
}

/**
 * Whether a recovery code may still be redeemed. Order matters: an expired or
 * destroyed challenge must never fall through to the code comparison.
 */
export function redeemGuard(input: RedeemGuardInput): { ok: boolean; reason?: string } {
  const now = input.now ?? Date.now();
  const max = input.maxAttempts ?? RECOVERY_MAX_ATTEMPTS;
  if (input.status === 'REDEEMED') return { ok: false, reason: 'Already completed' };
  if (input.status !== 'APPROVED')
    return { ok: false, reason: 'This request is not approved yet' };
  if (!input.codeHash || !input.codeExpiresAt)
    return { ok: false, reason: 'No active code — ask support to re-issue' };
  if (input.attempts >= max)
    return { ok: false, reason: 'Too many incorrect codes — ask support to re-issue' };
  if (new Date(input.codeExpiresAt).getTime() <= now)
    return { ok: false, reason: 'This code has expired — ask support to re-issue' };
  return { ok: true };
}

/** True once a failed attempt must destroy the code instead of allowing more. */
export function attemptsExhausted(attempts: number, max = RECOVERY_MAX_ATTEMPTS): boolean {
  return attempts >= max;
}

// ── Freeze ─────────────────────────────────────────────────────────────────
export interface FreezeWindow {
  hours: number;
  until: Date | null;
}

/**
 * Clamp the requested freeze and turn it into an instant. `hours = 0` means
 * "no freeze" and returns `until: null` — used when a super-admin releases a
 * hold early.
 */
export function freezeWindow(
  now: number,
  hours: number,
  maxHours = RECOVERY_MAX_FREEZE_HOURS
): FreezeWindow {
  if (!Number.isFinite(hours) || hours <= 0) return { hours: 0, until: null };
  const clamped = Math.min(Math.floor(hours), maxHours);
  return { hours: clamped, until: new Date(now + clamped * 3600 * 1000) };
}

/** Is a recovery freeze still holding the money rails shut? */
export function freezeActive(
  until: Date | string | null | undefined,
  now = Date.now()
): boolean {
  if (!until) return false;
  return new Date(until).getTime() > now;
}

/**
 * Freeze text for API errors and notifications. Deliberately UTC and
 * locale-free: the server's locale must not change a player-facing message.
 */
export function formatFreezeUntil(until: Date | string): string {
  const d = new Date(until);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = months[d.getUTCMonth()] ?? '';
  return `${pad(d.getUTCDate())} ${month} ${d.getUTCFullYear()} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/** Player-facing explanation, used verbatim in 403s and notifications. */
export function freezeMessage(until: Date | string): string {
  return (
    `Your account is in recovery protection until ${formatFreezeUntil(until)}. ` +
    'Withdrawals and new payout accounts are on hold while we make sure the account is safe. ' +
    'Contact support if you need this lifted.'
  );
}

/** Extend-only merge: a shorter freeze may never shorten an active one. */
export function mergeFreezeUntil(
  current: Date | string | null | undefined,
  next: Date | null | undefined,
  now = Date.now()
): Date | null {
  const cur = current && freezeActive(current, now) ? new Date(current) : null;
  if (!next) return cur;
  if (!cur) return new Date(next);
  return cur.getTime() >= new Date(next).getTime() ? cur : new Date(next);
}
