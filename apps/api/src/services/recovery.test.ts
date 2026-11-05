// apps/api/src/services/recovery.test.ts
//
// The recovery console's rules are pure functions on purpose: approval is the
// moment an account changes hands, so every guard is pinned here before any
// route touches the database.
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_ALPHABET,
  RECOVERY_BODY_LENGTH,
  RECOVERY_DEFAULT_FREEZE_HOURS,
  RECOVERY_EVIDENCE,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_MAX_FREEZE_HOURS,
  RECOVERY_MIN_CHECKS,
  approveGuard,
  attemptsExhausted,
  awaitingAgent,
  checklistCount,
  checklistPassed,
  formatFreezeUntil,
  freezeActive,
  freezeMessage,
  freezeWindow,
  generateCode,
  hashCode,
  hashesEqual,
  isRecoveryStatus,
  isWellFormedCode,
  mergeFreezeUntil,
  normalizeCode,
  redeemGuard,
  sanitizeChecks,
  statusLabel,
  threadOpen,
} from './recovery';

describe('generateCode', () => {
  it('builds a grouped, prefixed code of the expected shape', () => {
    const ticket = generateCode('ticket');
    expect(ticket).toMatch(/^TKT(-[A-Z2-9]{4}){3}$/);
    const code = generateCode('recovery');
    expect(code).toMatch(/^RVC(-[A-Z2-9]{4}){3}$/);
  });

  it('never emits a character that can be misread when handwritten', () => {
    for (let i = 0; i < 200; i += 1) {
      const body = generateCode('ticket').slice(4).replace(/-/g, '');
      expect(body).toHaveLength(RECOVERY_BODY_LENGTH);
      for (const ch of body) {
        expect(RECOVERY_ALPHABET.includes(ch)).toBe(true);
        expect('01OILU'.includes(ch)).toBe(false);
      }
    }
  });

  it('does not repeat across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateCode('recovery'));
    expect(seen.size).toBe(500);
  });
});

describe('normalizeCode / isWellFormedCode', () => {
  it('accepts however a player retypes it', () => {
    const code = generateCode('ticket');
    const messy = ` ${code.toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeCode(messy)).toBe(normalizeCode(code));
    expect(isWellFormedCode(messy, 'ticket')).toBe(true);
  });

  it('rejects a recovery code pasted into the ticket field, and vice versa', () => {
    expect(isWellFormedCode(generateCode('recovery'), 'ticket')).toBe(false);
    expect(isWellFormedCode(generateCode('ticket'), 'recovery')).toBe(false);
  });

  it('rejects wrong lengths and characters outside the alphabet', () => {
    expect(isWellFormedCode('TKT-ABCD', 'ticket')).toBe(false);
    expect(isWellFormedCode('TKT-ABCD-EFGH-IJKL', 'ticket')).toBe(false); // I, L, O are not in the alphabet
    expect(isWellFormedCode('', 'ticket')).toBe(false);
    expect(isWellFormedCode('RVC-ABCD-EFGH-IJK2', 'recovery')).toBe(false); // I
  });

  it('normalizes null/undefined without throwing', () => {
    expect(normalizeCode(undefined as unknown as string)).toBe('');
    expect(isWellFormedCode(null as unknown as string, 'ticket')).toBe(false);
  });
});

describe('hashCode / hashesEqual', () => {
  it('is stable across formatting differences', () => {
    const code = generateCode('recovery');
    expect(hashCode(code)).toBe(hashCode(code.toLowerCase().replace(/-/g, ' ')));
    expect(hashCode(code)).toHaveLength(64);
  });

  it('compares without leaking and refuses empty values', () => {
    const a = hashCode(generateCode('recovery'));
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashCode(generateCode('recovery')))).toBe(false);
    expect(hashesEqual(a, null)).toBe(false);
    expect(hashesEqual(null, undefined)).toBe(false);
  });
});

describe('evidence checklist', () => {
  it('exposes five checks with unique keys', () => {
   expectUnique(RECOVERY_EVIDENCE.map((c) => c.key));
    expect(RECOVERY_EVIDENCE).toHaveLength(5);
  });

  it('sanitizes arbitrary payloads to known keys only', () => {
    const checks = sanitizeChecks({
      depositRef: true,
      senderAccount: 'yes', // not a boolean true
      smuggled: true,
    });
    expect(Object.keys(checks).sort()).toEqual(
      RECOVERY_EVIDENCE.map((c) => c.key).sort()
    );
    expect(checks['depositRef']).toBe(true);
    expect(checks['senderAccount']).toBe(false);
    expect(checks['smuggled']).toBeUndefined();
    expect(checklistCount(checks)).toBe(1);
  });

  it('counts and passes at the threshold', () => {
    expect(checklistCount(null)).toBe(0);
    expect(checklistCount(undefined)).toBe(0);
    const two = sanitizeChecks({ depositRef: true, senderAccount: true });
    const three = sanitizeChecks({ depositRef: true, senderAccount: true, payoutAccount: true });
    expect(checklistPassed(two)).toBe(false); // default minimum is 3
    expect(checklistPassed(two, 2)).toBe(true);
    expect(checklistPassed(three)).toBe(true);
    expect(RECOVERY_MIN_CHECKS).toBe(3);
  });
});

describe('approveGuard (dual control)', () => {
  const base = {
    status: 'VERIFIED' as const,
    verifiedBy: 'admin-a',
    approverId: 'admin-b',
    isSuperAdmin: true,
  };

  it('allows a second super-admin to approve a verified request', () => {
    expect(approveGuard(base).ok).toBe(true);
  });

  it('refuses the admin who verified — the whole point of dual control', () => {
    const r = approveGuard({ ...base, approverId: 'admin-a' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/second admin/i);
  });

  it('refuses a manager', () => {
    expect(approveGuard({ ...base, isSuperAdmin: false }).ok).toBe(false);
  });

  it('refuses when nobody verified', () => {
    expect(approveGuard({ ...base, verifiedBy: null }).ok).toBe(false);
    expect(approveGuard({ ...base, status: 'PENDING' }).ok).toBe(false);
    expect(approveGuard({ ...base, status: 'IN_REVIEW' }).ok).toBe(false);
  });

  it('refuses to mint a second live code while one is outstanding', () => {
    const live = new Date(Date.now() + 60_000);
    const r = approveGuard({ ...base, status: 'APPROVED', codeExpiresAt: live });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already waiting/i);
  });

  it('re-issues after the previous code expired', () => {
    const dead = new Date(Date.now() - 60_000);
    expect(approveGuard({ ...base, status: 'APPROVED', codeExpiresAt: dead }).ok).toBe(true);
    expect(approveGuard({ ...base, status: 'APPROVED', codeExpiresAt: null }).ok).toBe(true);
  });

  it('refuses closed or burned requests', () => {
    expect(approveGuard({ ...base, status: 'REJECTED' }).ok).toBe(false);
    expect(approveGuard({ ...base, status: 'REDEEMED' }).ok).toBe(false);
    expect(approveGuard({ ...base, redeemedAt: new Date() }).ok).toBe(false);
    const burned = approveGuard({ ...base, status: 'EXPIRED' });
    expect(burned.ok).toBe(false);
    expect(burned.reason).toMatch(/failed attempts/i);
  });
});

describe('redeemGuard', () => {
  const live = {
    status: 'APPROVED' as const,
    codeHash: 'abc',
    codeExpiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  };

  it('allows a live code', () => {
    expect(redeemGuard(live).ok).toBe(true);
  });

  it('refuses anything that is not approved', () => {
    expect(redeemGuard({ ...live, status: 'PENDING' }).ok).toBe(false);
    expect(redeemGuard({ ...live, status: 'VERIFIED' }).ok).toBe(false);
    expect(redeemGuard({ ...live, status: 'REDEEMED' }).ok).toBe(false);
    expect(redeemGuard({ ...live, status: 'EXPIRED' }).ok).toBe(false);
  });

  it('refuses an expired code, a missing code and an exhausted challenge', () => {
    expect(redeemGuard({ ...live, codeExpiresAt: new Date(Date.now() - 1) }).ok).toBe(false);
    expect(redeemGuard({ ...live, codeHash: null }).ok).toBe(false);
    expect(redeemGuard({ ...live, codeExpiresAt: null }).ok).toBe(false);
    expect(redeemGuard({ ...live, attempts: RECOVERY_MAX_ATTEMPTS }).ok).toBe(false);
    expect(redeemGuard({ ...live, attempts: 1 }).ok).toBe(true);
  });

  it('counts the final attempt as fatal', () => {
    expect(attemptsExhausted(RECOVERY_MAX_ATTEMPTS - 1)).toBe(false);
    expect(attemptsExhausted(RECOVERY_MAX_ATTEMPTS)).toBe(true);
    expect(attemptsExhausted(99)).toBe(true);
  });
});

describe('freeze', () => {
  const now = Date.UTC(2026, 8, 19, 12, 0, 0);

  it('defaults to a 48 hour window and honours the clamp', () => {
    const w = freezeWindow(now, RECOVERY_DEFAULT_FREEZE_HOURS);
    expect(w.hours).toBe(48);
    expect(w.until?.getTime()).toBe(now + 48 * 3600 * 1000);
    expect(freezeWindow(now, RECOVERY_MAX_FREEZE_HOURS + 500).hours).toBe(
      RECOVERY_MAX_FREEZE_HOURS
    );
    expect(freezeWindow(now, 12.9).hours).toBe(12);
  });

  it('treats zero, negative and non-numeric hours as "no freeze"', () => {
    expect(freezeWindow(now, 0).until).toBeNull();
    expect(freezeWindow(now, -5).until).toBeNull();
    expect(freezeWindow(now, Number.NaN).until).toBeNull();
  });

  it('knows when a freeze is holding', () => {
    expect(freezeActive(new Date(now + 1000), now)).toBe(true);
    expect(freezeActive(new Date(now - 1000), now)).toBe(false);
    expect(freezeActive(null, now)).toBe(false);
    expect(freezeActive(undefined, now)).toBe(false);
  });

  it('merges extend-only: a short freeze never shortens a long one', () => {
    const longEnd = new Date(now + 72 * 3600 * 1000);
    const shortEnd = new Date(now + 2 * 3600 * 1000);
    expect(mergeFreezeUntil(longEnd, shortEnd, now)?.getTime()).toBe(longEnd.getTime());
    expect(mergeFreezeUntil(shortEnd, longEnd, now)?.getTime()).toBe(longEnd.getTime());
    // An already-lapsed freeze is simply replaced.
    const lapsed = new Date(now - 3600 * 1000);
    expect(mergeFreezeUntil(lapsed, shortEnd, now)?.getTime()).toBe(shortEnd.getTime());
    // A release (null) clears it, and a null next value keeps an active hold.
    expect(mergeFreezeUntil(longEnd, null, now)?.getTime()).toBe(longEnd.getTime());
  });

  it('formats deterministically in UTC for messages shown to players', () => {
    const text = formatFreezeUntil(new Date(Date.UTC(2026, 8, 21, 14, 30)));
    expect(text).toBe('21 Sep 2026 14:30 UTC');
    expect(freezeMessage(new Date(Date.UTC(2026, 8, 21, 14, 30)))).toContain(
      '21 Sep 2026 14:30 UTC'
    );
    expect(freezeMessage(new Date())).toMatch(/recovery protection/i);
  });
});

describe('status helpers', () => {
  it('labels every status', () => {
    for (const s of [
      'PENDING',
      'IN_REVIEW',
      'VERIFIED',
      'APPROVED',
      'REDEEMED',
      'REJECTED',
      'EXPIRED',
    ] as const) {
      expect(statusLabel(s)).toBeTruthy();
      expect(isRecoveryStatus(s)).toBe(true);
    }
    expect(isRecoveryStatus('SOMETHING')).toBe(false);
    expect(isRecoveryStatus(null)).toBe(false);
  });

  it('keeps a thread open until the case closes', () => {
    expect(threadOpen('PENDING')).toBe(true);
    expect(threadOpen('APPROVED')).toBe(true);
    expect(threadOpen('REDEEMED')).toBe(false);
    expect(threadOpen('REJECTED')).toBe(false);
    expect(threadOpen('EXPIRED')).toBe(false);
  });

  it('flags work waiting on an agent', () => {
    expect(awaitingAgent('PENDING')).toBe(true);
    expect(awaitingAgent('IN_REVIEW')).toBe(true);
    expect(awaitingAgent('VERIFIED')).toBe(false);
    expect(awaitingAgent('APPROVED')).toBe(false);
  });
});

function expectUnique(values: string[]) {
  expect(new Set(values).size).toBe(values.length);
}
