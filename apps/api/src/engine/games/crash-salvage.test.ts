import { describe, expect, it } from 'vitest';
import { CRASH_TAXI_MS } from './AviatorGame';
import { crashSalvageKind } from './crash-salvage';

const cfg = { configJson: { growth_rate: 0.00016 } };

describe('crashSalvageKind (leader takeover)', () => {
  it('settles a round that already crashed (detached settlement leftover)', () => {
    expect(
      crashSalvageKind({
        status: 'CRASHED',
        startedAt: Date.now() - 10_000,
        crashedAt: Date.now() - 100,
        crashPoint: 2.4,
        config: cfg,
      })
    ).toBe('settle');
  });

  it('settles a FLYING round whose elapsed multiplier already passed the crash point', () => {
    // taxi is 2500ms to 1.00x; a 0.4 crash is well inside the taxi window
    expect(
      crashSalvageKind(
        {
          status: 'FLYING',
          startedAt: 0,
          crashedAt: null,
          crashPoint: 0.4,
          config: cfg,
        },
        CRASH_TAXI_MS
      )
    ).toBe('settle');
  });

  it('resumes a FLYING round that has not yet reached its crash point', () => {
    expect(
      crashSalvageKind(
        {
          status: 'FLYING',
          startedAt: 0,
          crashedAt: null,
          crashPoint: 8,
          config: cfg,
        },
        200
      )
    ).toBe('resume');
  });

  it('refunds WAITING/BETTING rounds that never took off', () => {
    const base = {
      startedAt: null,
      crashedAt: null,
      crashPoint: 3.2,
      config: cfg,
    };
    expect(crashSalvageKind({ ...base, status: 'WAITING' })).toBe('refund');
    expect(crashSalvageKind({ ...base, status: 'BETTING' })).toBe('refund');
  });

  it('does nothing when there is no redis state (fresh clock)', () => {
    expect(crashSalvageKind(null)).toBe('none');
  });
});
