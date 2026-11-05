import { describe, expect, it } from 'vitest';
import { ROUND_RESULTS, SETTLED_ROUND_RESULTS } from './index';

describe('shared RoundResult', () => {
  it('matches the Prisma enum including PUSH and PENDING', () => {
    expect([...ROUND_RESULTS].sort()).toEqual(
      ['BUST', 'CASHOUT', 'LOSE', 'PENDING', 'PUSH', 'WIN'].sort()
    );
  });

  it('settled results never include PENDING', () => {
    expect(SETTLED_ROUND_RESULTS).not.toContain('PENDING');
    expect(SETTLED_ROUND_RESULTS).toContain('PUSH');
  });
});
