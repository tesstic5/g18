import { describe, expect, it } from 'vitest';
import { amountSchema } from './index';

describe('amountSchema (float-artifact regression)', () => {
  it('accepts values that broke Number.isInteger(v*100)', () => {
    for (const v of [1.1, 0.29, 1.15, 8.11, 10, 0.01, 1234.56]) {
      expect(amountSchema.safeParse(v).success, `${v} should be valid`).toBe(true);
    }
  });
  it('still rejects >2dp and non-positive', () => {
    for (const v of [50.123, 0.001, 0, -5]) {
      expect(amountSchema.safeParse(v).success, `${v} should be invalid`).toBe(false);
    }
  });
});
