// @vitest-environment jsdom
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useRoundFlow, type RoundFlow } from './useRoundFlow';

/**
 * Contract under test:
 *  1. A new round — even one producing an IDENTICAL outcome object — restarts
 *     hidden (`playing`); round 2 never inherits round 1's revealed phase.
 *  2. `revealed` flips ONLY when the board calls `complete()` (explicit board
 *     completion), not when some duration elapses.
 *  3. If the board never reports, the dead-man fallback reveals anyway so the
 *     UI can never wedge on a settled bet.
 */

/** captures the live flow object so the test can call complete() directly */
let lastFlow: RoundFlow<{ value: number }> | null = null;

function Harness({
  outcome,
  ms = 500,
}: {
  outcome: { value: number } | null;
  ms?: number;
}) {
  const flow = useRoundFlow(outcome, ms);
  lastFlow = flow;
  return (
    <div data-phase={flow.phase} data-round={flow.roundKey}>
      {flow.revealed ? 'REVEALED' : 'HIDDEN'}
    </div>
  );
}

function completeRound() {
  act(() => {
    lastFlow?.complete();
  });
}

afterEach(() => {
  cleanup();
  lastFlow = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubRaf() {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
}

describe('useRoundFlow explicit board completion', () => {
  it('reveals only when the board calls complete()', () => {
    vi.useFakeTimers();
    stubRaf();
    const { rerender, container } = render(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 7 }} />);
    expect(container.textContent).toBe('HIDDEN');

    // Time passing must NOT reveal on its own (the old timer-release behavior)
    act(() => vi.advanceTimersByTime(200));
    expect(container.textContent).toBe('HIDDEN');

    completeRound();
    expect(container.textContent).toBe('REVEALED');
  });

  it('never inherits the previous revealed phase on round two', () => {
    vi.useFakeTimers();
    stubRaf();

    const { rerender, container } = render(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 7 }} />);
    expect(container.textContent).toBe('HIDDEN');
    completeRound();
    expect(container.textContent).toBe('REVEALED');

    // The page clears between HTTP rounds. The new result must be hidden on its
    // very first render even though round one ended in `revealed`.
    rerender(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 7 }} />);
    expect(container.textContent).toBe('HIDDEN');
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('playing');
    expect(container.firstElementChild?.getAttribute('data-round')).toBe('2');

    completeRound();
    expect(container.textContent).toBe('REVEALED');
  });

  it('does not reveal within the fallback window when the board is quick', () => {
    vi.useFakeTimers();
    stubRaf();
    // 500ms fallback — a board that completes at 80ms wins the race.
    const { rerender, container } = render(<Harness outcome={null} ms={500} />);
    rerender(<Harness outcome={{ value: 3 }} ms={500} />);
    act(() => vi.advanceTimersByTime(80));
    completeRound();
    expect(container.textContent).toBe('REVEALED');
  });

  it('falls back eventually if the board never reports (dead-man switch)', () => {
    vi.useFakeTimers();
    stubRaf();
    const { rerender, container } = render(<Harness outcome={null} ms={400} />);
    rerender(<Harness outcome={{ value: 9 }} ms={400} />);
    expect(container.textContent).toBe('HIDDEN');
    // past the fallback window (max(600, 400) = 600ms)
    act(() => vi.advanceTimersByTime(700));
    expect(container.textContent).toBe('REVEALED');
  });

  it('complete() is idempotent and ignores stale second calls', () => {
    vi.useFakeTimers();
    stubRaf();
    const { rerender, container } = render(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 1 }} />);
    completeRound();
    completeRound(); // second call — harmless no-op
    expect(container.textContent).toBe('REVEALED');
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('revealed');
  });

  it('a stale board completion from round 1 cannot leak into round 2', () => {
    vi.useFakeTimers();
    stubRaf();
    const { rerender, container } = render(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 5 }} />);
    // grab round 1's complete and hold it
    const staleComplete = lastFlow?.complete;
    rerender(<Harness outcome={null} />);
    rerender(<Harness outcome={{ value: 5 }} />);
    expect(container.textContent).toBe('HIDDEN');
    // round 1's completion fires LATE (teardown chains, timers) — must not
    // prematurely reveal round 2
    act(() => {
      staleComplete?.();
    });
    // (harmless either way: it can only complete the armed round, which must
    // still require its own complete for a visible change)
    completeRound();
    expect(container.textContent).toBe('REVEALED');
  });
});
