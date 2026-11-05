// Regression tests for the session-state information leak.
//
// The session recovery endpoint (GET /games/:slug/session) returned the RAW
// SessionState, which embeds `extra.mines` (Mines) and `extra.trapsByFloor`
// (Tower). A player could start a round, read the answers, and clear the board
// every time. `toView()` existed to strip them but the route bypassed it.
import { describe, expect, it } from 'vitest';
import { sessionManager } from './SessionManager';
import type { SessionState } from './gameSessions';

// toView() is private; exercise it through the same path the route uses.
const callToView = (state: SessionState) =>
  (
    sessionManager as unknown as {
      toView(s: SessionState): { extra: Record<string, unknown> };
    }
  ).toView(state);

function baseState(extra: Record<string, unknown>): SessionState {
  return {
    roundId: 'r1',
    slug: 'mines',
    betAmount: '10.00',
    clientSeed: 'cs',
    nonce: 0,
    rawOutcome: 0.5,
    status: 'ACTIVE',
    stepIndex: 0,
    currentMultiplier: 1,
    nextMultiplier: 1.2,
    steps: [],
    extra,
    configSnapshot: {},
    forceMode: 'NONE',
    demo: false,
    createdAt: Date.now(),
  };
}

describe('session view sanitization', () => {
  it('never exposes mine positions', () => {
    const view = callToView(
      baseState({
        gridSize: 25,
        mineCount: 3,
        mines: [4, 11, 19],
        revealed: [],
      })
    );
    expect(view.extra.mines).toBeUndefined();
    // The mine positions themselves must not appear anywhere in the payload.
    // (Note: the literal string "mines" legitimately appears as the slug.)
    expect(JSON.stringify(view.extra)).not.toContain('"mines"');
    expect(JSON.stringify(view)).not.toContain('[4,11,19]');
    // ...while keeping the fields the UI legitimately needs
    expect(view.extra.gridSize).toBe(25);
    expect(view.extra.mineCount).toBe(3);
  });

  it('never exposes tower trap positions', () => {
    const view = callToView(
      baseState({
        difficulty: 'medium',
        cols: 4,
        trapsPerFloor: 2,
        trapsByFloor: [
          [0, 2],
          [1, 3],
        ],
        floor: 0,
      })
    );
    expect(view.extra.trapsByFloor).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('trapsByFloor');
    expect(view.extra.difficulty).toBe('medium');
  });

  it('is an allow-list: unknown secret fields are withheld by default', () => {
    // A future game adding a secret must not leak just because nobody
    // remembered to add a `delete` for it.
    const view = callToView(
      baseState({
        gridSize: 25,
        someFutureSecret: [1, 2, 3],
        winningCard: 'A♠',
      })
    );
    expect(view.extra.someFutureSecret).toBeUndefined();
    expect(view.extra.winningCard).toBeUndefined();
    expect(view.extra.gridSize).toBe(25);
  });
});
