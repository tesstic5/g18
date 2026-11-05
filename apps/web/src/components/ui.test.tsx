// apps/web/src/components/ui.test.tsx — BetHistory row normalization.
// Regression guard for the "− −₨NaN" bug: all three tabs (My Bets / All Bets /
// Top Wins) are fed by three DIFFERENT server shapes, none of which matched the
// BetRow interface, so every row rendered a NaN amount and a "−" multiplier.
import { describe, it, expect } from 'vitest';
import { normalizeRow } from './ui';

describe('BetHistory normalizeRow', () => {
  it('maps a "My Bets" row from GET /games/:slug/history', () => {
    const r = normalizeRow(
      {
        id: 'round1',
        betAmount: '10.00',
        result: 'WIN',
        payoutMultiplier: '1.9500',
        payoutAmount: '19.50',
        createdAt: '2026-08-16T10:00:00.000Z',
      },
      0
    );
    expect(r.id).toBe('round1');
    expect(r.betAmount).toBe(10);
    expect(r.multiplier).toBe(1.95);
    expect(r.profit).toBeCloseTo(9.5, 2);
    expect(r.result).toBe('WIN');
    expect(Number.isNaN(r.profit)).toBe(false);
  });

  it('shows a LOSE row as the negative stake, not NaN', () => {
    const r = normalizeRow(
      {
        id: 'r2',
        betAmount: 25,
        result: 'LOSE',
        payoutMultiplier: '0',
        payoutAmount: '0',
      },
      0
    );
    expect(r.profit).toBe(-25);
    expect(r.result).toBe('LOSE');
  });

  it('maps an "All Bets" socket row (game:live-bet)', () => {
    const r = normalizeRow(
      {
        userId_masked: 'Pl***23',
        betAmount: 50,
        result: 'win',
        payoutMultiplier: 2,
        payoutAmount: 100,
      },
      3
    );
    expect(r.username).toBe('Pl***23');
    expect(r.result).toBe('WIN');
    expect(r.profit).toBe(50);
    expect(r.id).toBeTruthy(); // socket rows have no id — must still get a key
  });

  it('maps a "Top Wins" live-feed row (no `result` field at all)', () => {
    const r = normalizeRow(
      {
        user: 'Ah***12',
        game: 'dice',
        betAmount: 5,
        payoutAmount: 40,
        multiplier: 8,
        at: 1786878000000,
      },
      1
    );
    expect(r.username).toBe('Ah***12');
    expect(r.multiplier).toBe(8);
    expect(r.profit).toBe(35);
    expect(r.result).toBe('WIN'); // inferred from payout > 0
  });

  it('treats BUST (crash games) as a loss', () => {
    const r = normalizeRow(
      { id: 'x', betAmount: 100, result: 'BUST', payoutAmount: 0 },
      0
    );
    expect(r.result).toBe('LOSE');
    expect(r.profit).toBe(-100);
  });

  it('never produces NaN from a completely empty row', () => {
    const r = normalizeRow({}, 0);
    expect(Number.isNaN(r.profit)).toBe(false);
    expect(Number.isNaN(r.betAmount)).toBe(false);
    expect(Number.isNaN(r.multiplier)).toBe(false);
  });
});
