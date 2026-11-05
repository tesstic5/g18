// apps/api/src/services/securityPolicy.test.ts
//
// Unit tests for the pure security rules added after SECURITY-INVENTORY.md.
// Nothing here touches Prisma, Redis or Fastify — if a test needs a stack, the
// logic belongs in a route, not in securityPolicy.ts.
import { describe, expect, it } from 'vitest';
import {
  COMMON_PASSWORDS,
  PASSWORD_HARD_MAX,
  PASSWORD_HARD_MIN,
  ageInDays,
  characterVariety,
  checkPassword,
  dualControlMessage,
  dualControlStage,
  idleDecision,
  lockoutDecision,
  lockoutEntryIsLive,
  lockoutMessage,
  newDeviceBlockMessage,
  newDeviceBlocked,
  normalizeFailMode,
  normalizeNewDevicePolicy,
  onFailedAttempt,
  retentionCutoff,
  sessionVersionMatches,
  stepUpFresh,
  stepUpMessage,
} from './securityPolicy';

const NOW = new Date('2026-09-19T12:00:00Z').getTime();

describe('checkPassword — length', () => {
  it('accepts a reasonable password', () => {
    expect(checkPassword('Tractor-Cricket-91')).toEqual({ ok: true });
  });

  it('rejects an empty or missing password', () => {
    for (const v of ['', undefined, null, 12345, {}]) {
      const r = checkPassword(v);
      expect(r.ok).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it('rejects anything under the hard minimum', () => {
    const r = checkPassword('aB3$a');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(PASSWORD_HARD_MIN));
  });

  it('honours a policy minimum above the hard floor', () => {
    const r = checkPassword('aB3$efg', { minLength: 12 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('12');
  });

  it('never lets a policy minimum drop below the hard floor', () => {
    // minLength: 3 must not weaken the platform — 8 is the floor regardless.
    const r = checkPassword('aB3$', { minLength: 3 });
    expect(r.ok).toBe(false);
  });

  it('caps an absurd policy minimum at 32 so admin input cannot lock everyone out', () => {
    const r = checkPassword('aB3$xY9!'.padEnd(40, 'q'), { minLength: 9999 });
    expect(r.ok).toBe(true);
  });

  it('rejects a password longer than bcrypt can hash', () => {
    const r = checkPassword('aB3$xY9!'.repeat(12));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(PASSWORD_HARD_MAX));
  });

  it('rejects leading or trailing whitespace rather than silently trimming', () => {
    expect(checkPassword(' Tractor-Cricket-91').ok).toBe(false);
    expect(checkPassword('Tractor-Cricket-91 ').ok).toBe(false);
  });
});

describe('checkPassword — shape', () => {
  it('rejects every password on the common list (case-insensitively)', () => {
    for (const p of COMMON_PASSWORDS) {
      expect(checkPassword(p).ok, `expected ${p} to be rejected`).toBe(false);
      expect(checkPassword(p.toUpperCase()).ok, `expected ${p.toUpperCase()} to be rejected`).toBe(
        false
      );
    }
  });

  it('lets a common password through only when the operator turns the list off', () => {
    expect(checkPassword('password123').ok).toBe(false);
    expect(checkPassword('password123', { rejectCommon: false }).ok).toBe(true);
  });

  it('rejects digits-only passwords (the shape a phone signup invites)', () => {
    expect(checkPassword('8822774411').ok).toBe(false);
    expect(checkPassword('8822774411').reason).toContain('only numbers');
  });

  it('requires two character classes', () => {
    const r = checkPassword('abcdefghij');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('two of');
  });

  it('accepts letters+digits, letters+symbols and digits+symbols', () => {
    expect(checkPassword('karachi77x')).toEqual({ ok: true });
    expect(checkPassword('karachi!!')).toEqual({ ok: true });
    expect(checkPassword('7712345!!')).toEqual({ ok: true });
  });

  it('rejects a password with too little character variety', () => {
    const r = checkPassword('aaaaaaaaaaa1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('different characters');
  });

  it('counts character variety by distinct code points', () => {
    expect(characterVariety('aaaa')).toBe(1);
    expect(characterVariety('abcd')).toBe(4);
    expect(characterVariety('')).toBe(0);
  });
});

describe('checkPassword — identity reuse', () => {
  it('rejects the account\u2019s own phone number in any format', () => {
    const phone = '+92 300-1234567';
    expect(checkPassword('3001234567a!', { phone }).ok).toBe(false);
    expect(checkPassword('a!923001234567', { phone }).ok).toBe(false);
    expect(checkPassword('03001234567x!', { phone }).ok).toBe(false);
  });

  it('ignores a phone that is too short to be an identity', () => {
    expect(checkPassword('12345x!A', { phone: '12345' }).ok).toBe(true);
  });

  it('rejects the display name when it is long enough to matter', () => {
    expect(checkPassword('imran-khan-91', { displayName: 'Imran Khan' }).ok).toBe(false);
    expect(checkPassword('ImranKhan99x', { displayName: 'ImranKhan' }).ok).toBe(false);
  });

  it('does not block a 3-character display name from appearing', () => {
    expect(checkPassword('ali-1234x', { displayName: 'ali' }).ok).toBe(true);
  });

  it('does not block with no phone/name context at all', () => {
    expect(checkPassword('Tractor-Cricket-91', {}).ok).toBe(true);
  });
});

describe('lockoutDecision', () => {
  const opts = { maxAttempts: 8, lockMinutes: 15, now: NOW };

  it('reports remaining attempts while under the threshold', () => {
    expect(lockoutDecision({ failures: 0, lockedUntil: null }, opts)).toEqual({
      locked: false,
      retryAfter: 0,
      remaining: 8,
    });
    expect(lockoutDecision({ failures: 7, lockedUntil: null }, opts).remaining).toBe(1);
  });

  it('locks at the threshold even when no lock timestamp was written', () => {
    const d = lockoutDecision({ failures: 8, lockedUntil: null }, opts);
    expect(d.locked).toBe(true);
    expect(d.retryAfter).toBe(15 * 60);
    expect(d.remaining).toBe(0);
  });

  it('never chains re-locks off a stale counter once the lock was served', () => {
    // 9 recorded failures with an expired lock must NOT come back as locked,
    // or the player is locked out forever with no way to clear the counter.
    for (let ago = 1; ago < 5; ago += 1) {
      const d = lockoutDecision({ failures: 12, lockedUntil: NOW - ago }, opts);
      expect(d.locked).toBe(false);
      expect(d.retryAfter).toBe(0);
      expect(d.remaining).toBe(8);
    }
  });

  it('counts down an active lock', () => {
    const d = lockoutDecision({ failures: 9, lockedUntil: NOW + 5 * 60_000 }, opts);
    expect(d.locked).toBe(true);
    expect(d.retryAfter).toBe(300);
  });

  it('lets the account back in once the lock expires', () => {
    const d = lockoutDecision({ failures: 9, lockedUntil: NOW - 1 }, opts);
    expect(d.locked).toBe(false);
    expect(d.retryAfter).toBe(0);
  });

  it('treats a negative failure count as zero', () => {
    expect(lockoutDecision({ failures: -5, lockedUntil: null }, opts).remaining).toBe(8);
  });

  it('tolerates a nonsense maxAttempts without unlocking everyone', () => {
    const d = lockoutDecision({ failures: 1, lockedUntil: null }, {
      maxAttempts: 0,
      lockMinutes: 15,
      now: NOW,
    });
    expect(d.locked).toBe(true);
  });
});

describe('onFailedAttempt', () => {
  const opts = { maxAttempts: 3, lockMinutes: 10, now: NOW };

  it('increments the counter and stays unlocked below the threshold', () => {
    expect(onFailedAttempt({ failures: 0, lockedUntil: null }, opts)).toEqual({
      failures: 1,
      lockedUntil: null,
    });
    expect(onFailedAttempt({ failures: 1, lockedUntil: null }, opts).lockedUntil).toBe(null);
  });

  it('stamps the lock when the threshold is reached', () => {
    const s = onFailedAttempt({ failures: 2, lockedUntil: null }, opts);
    expect(s.failures).toBe(3);
    expect(s.lockedUntil).toBe(NOW + 10 * 60_000);
  });

  it('keeps pushing the lock forward on further failures', () => {
    const s = onFailedAttempt({ failures: 3, lockedUntil: NOW + 1000 }, opts);
    expect(s.lockedUntil).toBe(NOW + 10 * 60_000);
  });

  it('starts a fresh count on the first failure AFTER a served lock', () => {
    // Regression: counting failures recorded under an already-served lock again
    // re-locked the account on one mistyped password, and (until the Redis key
    // expired) made an expired lock look permanent.
    const s = onFailedAttempt({ failures: 9, lockedUntil: NOW - 60_000 }, opts);
    expect(s.failures).toBe(1);
    expect(s.lockedUntil).toBe(null);
    expect(lockoutDecision(s, { ...opts, now: NOW }).locked).toBe(false);
  });

  it('round-trips: lock, wait it out, mistype once, still allowed in', () => {
    const o = { maxAttempts: 3, lockMinutes: 15, now: NOW };
    let state: { failures: number; lockedUntil: number | null } = {
      failures: 3,
      lockedUntil: NOW + 60_000,
    };
    expect(lockoutDecision(state, o).locked).toBe(true);
    // the lock is served
    expect(lockoutDecision(state, { ...o, now: NOW + 61_000 }).locked).toBe(false);
    state = onFailedAttempt(state, { ...o, now: NOW + 61_000 });
    expect(lockoutDecision(state, { ...o, now: NOW + 61_000 }).locked).toBe(false);
    expect(lockoutDecision(state, { ...o, now: NOW + 61_000 }).remaining).toBe(2);
  });

  it('round-trips with lockoutDecision: the 8th failure locks the account', () => {
    const o = { maxAttempts: 8, lockMinutes: 15, now: NOW };
    let state = { failures: 0, lockedUntil: null as number | null };
    for (let i = 0; i < 7; i += 1) {
      expect(lockoutDecision(state, o).locked).toBe(false);
      state = onFailedAttempt(state, o);
    }
    expect(lockoutDecision(state, o).remaining).toBe(1);
    state = onFailedAttempt(state, o);
    expect(lockoutDecision(state, o).locked).toBe(true);
  });
});

describe('lockoutMessage / stepUpMessage / dualControlMessage / newDeviceBlockMessage', () => {
  it('phrases the lockout in minutes and never confirms the account exists', () => {
    const msg = lockoutMessage(30);
    expect(msg).toContain('1 minute');
    expect(msg.toLowerCase()).toContain('recover your account');
    expect(msg).not.toMatch(/phone|number not found|no account/i);
  });

  it('rounds a partial minute up', () => {
    expect(lockoutMessage(61)).toContain('2 minute');
  });

  it('names the step-up window and why it exists', () => {
    expect(stepUpMessage(15)).toContain('15 minute');
    expect(stepUpMessage(15)).toContain('Confirm your password');
  });

  it('quotes both amounts in the dual-control message', () => {
    const msg = dualControlMessage(75000, 50000);
    expect(msg).toContain('75000');
    expect(msg).toContain('50000');
    expect(msg).toContain('second admin');
  });

  it('offers the recovery route out of a new-device block', () => {
    expect(newDeviceBlockMessage()).toContain('recover your account');
  });
});

describe('dualControlStage', () => {
  it('is off when the threshold is zero or negative', () => {
    expect(dualControlStage({ amount: 1e9, threshold: 0, approverId: 'a' }).stage).toBe(
      'not-required'
    );
    expect(dualControlStage({ amount: 1e9, threshold: -5, approverId: 'a' }).stage).toBe(
      'not-required'
    );
  });

  it('is off below the threshold and on AT the threshold', () => {
    expect(dualControlStage({ amount: 49999, threshold: 50000, approverId: 'a' }).stage).toBe(
      'not-required'
    );
    expect(dualControlStage({ amount: 50000, threshold: 50000, approverId: 'a' }).stage).toBe(
      'awaiting-first'
    );
  });

  it('asks for a first approval when nobody has signed yet', () => {
    const s = dualControlStage({ amount: 60000, threshold: 50000, approverId: 'admin-1' });
    expect(s).toEqual({ stage: 'awaiting-first' });
  });

  it('asks for a second, DIFFERENT admin after the first signature', () => {
    const s = dualControlStage({
      amount: 60000,
      threshold: 50000,
      firstApproverId: 'admin-1',
      approverId: 'admin-2',
    });
    expect(s).toEqual({ stage: 'awaiting-second', firstApproverId: 'admin-1' });
  });

  it('refuses the same admin approving twice', () => {
    const s = dualControlStage({
      amount: 60000,
      threshold: 50000,
      firstApproverId: 'admin-1',
      approverId: 'admin-1',
    });
    expect(s.stage).toBe('rejected');
    if (s.stage === 'rejected') expect(s.reason).toContain('second admin');
  });

  it('treats a non-finite amount as below the threshold (never blocks a payout on bad data)', () => {
    expect(
      dualControlStage({ amount: Number.NaN, threshold: 50000, approverId: 'a' }).stage
    ).toBe('not-required');
  });
});

describe('idleDecision', () => {
  it('does not expire anything when the timeout is disabled', () => {
    expect(
      idleDecision(new Date(NOW - 10 * 3_600_000), { timeoutMinutes: 0, now: NOW })
    ).toEqual({ expired: false, idleMinutes: 0 });
  });

  it('keeps a session that was active recently', () => {
    const d = idleDecision(new Date(NOW - 5 * 60_000), { timeoutMinutes: 60, now: NOW });
    expect(d.expired).toBe(false);
    expect(d.idleMinutes).toBe(5);
  });

  it('expires a session that sat idle past the timeout', () => {
    expect(
      idleDecision(new Date(NOW - 61 * 60_000), { timeoutMinutes: 60, now: NOW }).expired
    ).toBe(true);
  });

  it('expires exactly at the boundary (strictly greater-than comparison)', () => {
    expect(idleDecision(new Date(NOW - 60 * 60_000), { timeoutMinutes: 60, now: NOW }).expired).toBe(
      false
    );
    expect(
      idleDecision(new Date(NOW - 60 * 60_000 - 1), { timeoutMinutes: 60, now: NOW }).expired
    ).toBe(true);
  });

  it('treats a missing or unparseable timestamp as active (fail-open on session hygiene, as designed)', () => {
    for (const v of [null, undefined, 'not-a-date']) {
      expect(idleDecision(v as never, { timeoutMinutes: 60, now: NOW }).expired).toBe(false);
    }
  });
});

describe('stepUpFresh', () => {
  it('is fresh inside the window', () => {
    expect(stepUpFresh(new Date(NOW - 60_000), { windowMinutes: 15, now: NOW })).toBe(true);
  });

  it('is stale outside the window', () => {
    expect(stepUpFresh(new Date(NOW - 16 * 60_000), { windowMinutes: 15, now: NOW })).toBe(false);
  });

  it('is stale when the window is disabled but no stamp exists', () => {
    expect(stepUpFresh(null, { windowMinutes: 0, now: NOW })).toBe(true);
    expect(stepUpFresh(null, { windowMinutes: 15, now: NOW })).toBe(false);
  });

  it('is stale for a future stamp (clock skew cannot buy a longer window)', () => {
    expect(stepUpFresh(new Date(NOW + 10 * 60_000), { windowMinutes: 15, now: NOW })).toBe(false);
  });

  it('accepts epoch numbers and ISO strings', () => {
    expect(stepUpFresh(NOW - 1000, { windowMinutes: 15, now: NOW })).toBe(true);
    expect(stepUpFresh(new Date(NOW - 1000).toISOString(), { windowMinutes: 15, now: NOW })).toBe(
      true
    );
  });
});

describe('newDeviceBlocked', () => {
  it('never blocks under the default notify policy', () => {
    expect(
      newDeviceBlocked('notify', { knownDeviceCount: 5, isKnownDevice: false })
    ).toBe(false);
    expect(newDeviceBlocked(undefined, { knownDeviceCount: 5, isKnownDevice: false })).toBe(false);
  });

  it('blocks an unseen device under the block policy', () => {
    expect(newDeviceBlocked('block', { knownDeviceCount: 5, isKnownDevice: false })).toBe(true);
  });

  it('allows a device the account has used before', () => {
    expect(newDeviceBlocked('block', { knownDeviceCount: 5, isKnownDevice: true })).toBe(false);
  });

  it('never blocks an account with no device history (legacy/restored accounts)', () => {
    expect(newDeviceBlocked('block', { knownDeviceCount: 0, isKnownDevice: false })).toBe(false);
  });

  it('normalises junk policy values to notify', () => {
    expect(normalizeNewDevicePolicy('BLOCK')).toBe('notify');
    expect(normalizeNewDevicePolicy(null)).toBe('notify');
    expect(normalizeNewDevicePolicy('block')).toBe('block');
  });
});

describe('normalizeFailMode', () => {
  it('keeps the three supported modes', () => {
    expect(normalizeFailMode('memory')).toBe('memory');
    expect(normalizeFailMode('open')).toBe('open');
    expect(normalizeFailMode('closed')).toBe('closed');
  });

  it('defaults anything unrecognised to memory (never silently open)', () => {
    for (const v of ['OPEN', '', null, undefined, 'yolo', 1]) {
      expect(normalizeFailMode(v)).toBe('memory');
    }
  });
});

describe('retentionCutoff', () => {
  it('computes the cutoff in days', () => {
    const c = retentionCutoff(180, NOW);
    expect(c.days).toBe(180);
    expect(c.before?.getTime()).toBe(NOW - 180 * 86_400_000);
  });

  it('returns null (purge disabled) for 0, negatives and junk — never "purge everything"', () => {
    for (const v of [0, -1, null, undefined, 'soon']) {
      expect(retentionCutoff(v, NOW).before).toBe(null);
    }
  });

  it('treats a numeric string as a number', () => {
    expect(retentionCutoff('90', NOW).before?.getTime()).toBe(NOW - 90 * 86_400_000);
  });
});

describe('ageInDays', () => {
  it('rounds down to whole days', () => {
    expect(ageInDays(new Date(NOW - 3.9 * 86_400_000), NOW)).toBe(3);
  });

  it('is Infinity for a missing or unparseable timestamp (watchdog must not see "fresh")', () => {
    expect(ageInDays(null, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(ageInDays('nope', NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is 0 for right now', () => {
    expect(ageInDays(new Date(NOW), NOW)).toBe(0);
  });
});

describe('sessionVersionMatches', () => {
  it('accepts a token minted at the current version', () => {
    expect(sessionVersionMatches(3, 3)).toBe(true);
    expect(sessionVersionMatches(0, 0)).toBe(true);
  });

  it('rejects a token minted before a revocation bump', () => {
    expect(sessionVersionMatches(2, 3)).toBe(false);
    expect(sessionVersionMatches(0, 1)).toBe(false);
  });

  it('treats an absent version as 0 (tokens issued before the feature)', () => {
    expect(sessionVersionMatches(undefined, 0)).toBe(true);
    expect(sessionVersionMatches(undefined, null)).toBe(true);
    expect(sessionVersionMatches(undefined, 1)).toBe(false);
  });

  it('does not accept junk stamps', () => {
    for (const junk of ['3', {}, [], Number.NaN, Infinity]) {
      expect(sessionVersionMatches(junk, 0)).toBe(true); // reads as 0 …
      expect(sessionVersionMatches(junk, 2)).toBe(false); // … and never matches a bumped account
    }
  });
});

describe('lockoutEntryIsLive (stale-state guard)', () => {
  const NOW2 = new Date('2026-09-19T12:00:00Z').getTime();

  it('treats a plain counter as live', () => {
    expect(lockoutEntryIsLive({ lockedUntil: null }, { now: NOW2 })).toBe(true);
    expect(lockoutEntryIsLive({}, { now: NOW2 })).toBe(true);
  });

  it('treats an active lock as live', () => {
    expect(lockoutEntryIsLive({ lockedUntil: NOW2 + 60_000 }, { now: NOW2 })).toBe(true);
  });

  it('keeps a recently-served lock (cleanup is the TTL\'s job, not a re-lock)', () => {
    expect(lockoutEntryIsLive({ lockedUntil: NOW2 - 60_000 }, { now: NOW2 })).toBe(true);
  });

  it('rejects an absurd future timestamp (clock skew / corruption)', () => {
    expect(lockoutEntryIsLive({ lockedUntil: NOW2 + 5 * 86_400_000 }, { now: NOW2 })).toBe(false);
  });

  it('rejects an entry that long outlived its lock', () => {
    expect(lockoutEntryIsLive({ lockedUntil: NOW2 - 5 * 86_400_000 }, { now: NOW2 })).toBe(false);
  });

  it('rejects missing and non-numeric state', () => {
    expect(lockoutEntryIsLive(null, { now: NOW2 })).toBe(false);
    expect(lockoutEntryIsLive(undefined, { now: NOW2 })).toBe(false);
    expect(lockoutEntryIsLive({ lockedUntil: Number.NaN }, { now: NOW2 })).toBe(false);
  });

  it('honours a caller-supplied maximum', () => {
    expect(
      lockoutEntryIsLive({ lockedUntil: NOW2 + 90_000 }, { now: NOW2, maxLockMs: 60_000 })
    ).toBe(false);
  });
});
