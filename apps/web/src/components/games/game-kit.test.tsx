// @vitest-environment jsdom
// apps/web/src/components/games/game-kit.test.tsx — D-090: the result banner
// must re-trigger for EVERY round — even when the previous round had the exact
// same result+multiplier (e.g. two 0× wheel losses in a row). The old code
// stored the last key forever and silently swallowed identical repeats.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { ResultBanner } from './game-kit';

afterEach(() => {
  vi.useRealTimers();
});

function expectBannerShown(container: HTMLElement) {
  expect(container.textContent).toContain('YOU LOSE');
}

describe('ResultBanner — consecutive identical results (D-090)', () => {
  it('re-triggers when the result passes through null (new round)', () => {
    vi.useFakeTimers();
    const { rerender, container } = render(
      React.createElement(ResultBanner, { result: null as never })
    );
    // round 1: LOSE with the same multiplier as round 3 will have
    rerender(React.createElement(ResultBanner, { result: 'LOSE', multiplier: 0 }));
    expectBannerShown(container);
    // banner hides after its 2.6s lifetime
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(container.textContent).not.toContain('YOU LOSE');
    // next round starts (page clears the round state → result null)
    rerender(React.createElement(ResultBanner, { result: null as never }));
    expect(container.textContent).not.toContain('YOU LOSE');
    // round 2: IDENTICAL result+multiplier — must still show
    rerender(React.createElement(ResultBanner, { result: 'LOSE', multiplier: 0 }));
    expectBannerShown(container);
    // and it hides again after its lifetime (timer restarted, not stale)
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(container.textContent).not.toContain('YOU LOSE');
  });
});
