// @vitest-environment jsdom
// apps/web/src/hooks/useGame.test.tsx — D-090 state machine unit tests:
//  1. BETTING is set SYNCHRONOUSLY (the bet popup closes instantly)
//  2. double-tap → second call is SKIPPED (no double bet, one network call)
//  3. settled round → RESULT_* → auto-IDLE after ~2.9s (Play re-enables, auto-play continues)
//  4. error → rollback + ERROR → auto-IDLE after ~1.6s
//  5. crash/wingo PLACED → PLAYING, no auto-IDLE (the page resets via socket)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: vi.fn(),
  betStatus: vi.fn(),
  http: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  uuid: () => 'test-uuid',
}));
vi.mock('../lib/app', () => ({
  invalidate: { gameHistory: vi.fn(), sessionStats: vi.fn(), balance: vi.fn() },
  socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import { api } from '../lib/api';
import { useGame } from './index';
import { useGameStore, useWalletStore } from '../stores';

let placeBetRef: ((amount: number, choices: unknown) => Promise<unknown>) | null = null;
let completeRoundRef: (() => void) | null = null;
function Harness({
  slug,
  clientSeed,
  demo,
  manual,
}: {
  slug: string;
  clientSeed: string;
  demo?: boolean;
  manual?: boolean;
}) {
  const { placeBet, completeRound } = useGame(
    slug,
    clientSeed,
    demo,
    manual ? null : 2900
  );
  placeBetRef = placeBet;
  completeRoundRef = completeRound;
  return null;
}
const renderHook = (slug = 'dice', demo = false, manual = false) =>
  render(React.createElement(Harness, { slug, clientSeed: 'test-seed', demo, manual }));

const winRound = {
  roundId: 'r1',
  result: 'WIN',
  payoutAmount: 98,
  nonce: 1,
  seedHash: 'h',
  newBalance: { real: '1048', bonus: '0', gifted: '0', locked: '0' },
};

beforeEach(() => {
  vi.useFakeTimers();
  useGameStore.getState().setState('IDLE');
  useWalletStore.getState().setBalance({ real: 1000, bonus: 0, gifted: 0, locked: 0 });
  vi.mocked(api).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useGame — D-090 bet lifecycle', () => {
  it('sets BETTING synchronously — before the network resolves', () => {
    renderHook();
    vi.mocked(api).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    );
    const p = placeBetRef!(50, {});
    // synchronous part already ran: guard + BETTING + optimistic deduction
    expect(useGameStore.getState().state).toBe('BETTING');
    expect(useWalletStore.getState().real).toBe(950); // optimistic deduction
    void p;
  });

  it('SKIPS a second tap while a bet is in flight — one network call only', async () => {
    renderHook();
    vi.mocked(api).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    );
    const p1 = placeBetRef!(50, {});
    const p2 = placeBetRef!(50, {});
    expect(useGameStore.getState().state).toBe('BETTING');
    const r2 = await p2;
    expect((r2 as { status?: string }).status).toBe('SKIPPED');
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1); // no double bet
    void p1;
  });

  it('settles to RESULT_WIN then auto-returns to IDLE after ~2.9s', async () => {
    renderHook();
    vi.mocked(api).mockResolvedValue(winRound);
    await act(async () => {
      await placeBetRef!(50, {});
    });
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    expect(useWalletStore.getState().real).toBe(1048); // server truth applied
    // still locked right after the result…
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    // …then released once the banner has been visible
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(useGameStore.getState().state).toBe('IDLE');
  });

  it('manual mode unlocks only when the board reports animation completion', async () => {
    renderHook('dice', false, true);
    vi.mocked(api).mockResolvedValue(winRound);
    await act(async () => {
      await placeBetRef!(50, {});
    });
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    act(() => completeRoundRef!());
    expect(useGameStore.getState().state).toBe('IDLE');
  });

  it('on error: rolls back the deduction, ERROR, then auto-IDLE after ~1.6s', async () => {
    renderHook();
    vi.mocked(api).mockRejectedValue(new Error('boom'));
    await act(async () => {
      await expect(placeBetRef!(50, {})).rejects.toThrow('boom');
    });
    expect(useGameStore.getState().state).toBe('ERROR');
    expect(useWalletStore.getState().real).toBe(1000); // rolled back
    await act(async () => {
      vi.advanceTimersByTime(1800);
    });
    expect(useGameStore.getState().state).toBe('IDLE');
  });

  it('plinko 16 balls deducts 16× the per-ball stake', () => {
    renderHook('plinko');
    vi.mocked(api).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    );
    void placeBetRef!(50, { balls: 16 });
    expect(useWalletStore.getState().real).toBe(200); // 1000 − 16×50
  });

  it('crash/wingo PLACED → PLAYING and the hook does NOT auto-release (page resets via socket)', async () => {
    renderHook('aviator');
    vi.mocked(api).mockResolvedValue({ status: 'PLACED', roundId: 'r2' });
    await act(async () => {
      await placeBetRef!(25, { target: 1.1 });
    });
    expect(useGameStore.getState().state).toBe('PLAYING');
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(useGameStore.getState().state).toBe('PLAYING'); // still locked — round live
  });

  it('a stale IDLE timer from a previous round cannot reset a NEWER round', async () => {
    renderHook();
    // first round: slow response — the IDLE timer token belongs to round 1
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(api).mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      })
    );
    const p1 = placeBetRef!(50, {});
    // second round resolves immediately (its own timer token)
    vi.mocked(api).mockResolvedValueOnce(winRound);
    await act(async () => {
      await placeBetRef!(60, {});
    });
    // round 1 finally resolves LATE — after round 2 already got RESULT_WIN
    await act(async () => {
      resolveFirst(winRound);
      await p1;
    });
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    // round 1's stale timer must NOT flip round 2's state early
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(useGameStore.getState().state).toBe('RESULT_WIN');
    // round 2's own timer eventually releases it
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(useGameStore.getState().state).toBe('IDLE');
  });
});
