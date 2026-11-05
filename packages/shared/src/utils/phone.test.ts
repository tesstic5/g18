// packages/shared/src/utils/phone.test.ts
//
// Players (but not admins) could not log in: the login button was `disabled`
// until normalizePhone() returned a value, and the old parser rejected several
// formats people really type. The button just sat there greyed out with no
// explanation. These tests pin down every accepted format and make sure the
// rejection messages are actually useful.
import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  describePhoneProblem,
  formatPhone,
  phoneLooksValid,
} from './phone';

const CANON = '+923001234567';

describe('normalizePhone — accepted formats', () => {
  it('handles every way a Pakistani number gets typed', () => {
    const inputs = [
      '3001234567', // bare subscriber
      '03001234567', // national
      '923001234567', // country code, no plus
      '+923001234567', // full international
      '00923001234567', // 00 trunk prefix  (REJECTED before this fix)
      '+9203001234567', // country code + national 0 (REJECTED before)
      '0092 300 1234567', // 00 + spacing     (REJECTED before)
      '+92 300 1234567',
      '0300 1234567',
      '0300-1234567',
      '0300.1234567',
      '  03001234567  ',
      '(0300) 1234567',
    ];
    for (const i of inputs) {
      expect(normalizePhone(i), `input: ${JSON.stringify(i)}`).toBe(CANON);
      expect(describePhoneProblem(i), `input: ${JSON.stringify(i)}`).toBeNull();
    }
  });

  it('works for the other network prefixes', () => {
    expect(normalizePhone('03214567890')).toBe('+923214567890');
    expect(normalizePhone('0345 1112223')).toBe('+923451112223');
    expect(normalizePhone('+92 312 9998887')).toBe('+923129998887');
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    expect(normalizePhone(normalizePhone('03001234567')!)).toBe(CANON);
  });
});

describe('normalizePhone — rejected input', () => {
  it('rejects numbers that are not Pakistani mobiles', () => {
    for (const i of [
      '',
      '   ',
      'abc',
      '0300123456',
      '030012345678',
      '02112345678',
      '+441234567890',
    ]) {
      expect(normalizePhone(i), `input: ${JSON.stringify(i)}`).toBeNull();
    }
  });

  it('explains WHY, so the form can tell the user', () => {
    expect(describePhoneProblem('')).toMatch(/enter your mobile/i);
    expect(describePhoneProblem('0300123456')).toMatch(/too short/i);
    expect(describePhoneProblem('030012345678')).toMatch(/too long/i);
    expect(describePhoneProblem('02112345678')).toMatch(/start with 3/i);
    // never returns an empty/blank reason
    for (const i of ['', 'abc', '1', '999999999999999']) {
      const msg = describePhoneProblem(i);
      expect(msg && msg.length).toBeGreaterThan(10);
    }
  });
});

describe('helpers', () => {
  it('formatPhone renders a readable number', () => {
    expect(formatPhone('03001234567')).toBe('+92 300 1234567');
  });

  it('phoneLooksValid agrees with normalizePhone', () => {
    for (const i of ['03001234567', '00923001234567', 'nope', '0300123456']) {
      expect(phoneLooksValid(i)).toBe(normalizePhone(i) !== null);
    }
  });
});
