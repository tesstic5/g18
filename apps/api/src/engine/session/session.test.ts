// apps/api/src/engine/session/session.test.ts — D-092 session logic verification.
// The session model (ONE bet per round, multiplier grows, cashout settles
// bet×mult) must keep the advertised RTP — these sims play realistic strategies
// over 200k rawOutcomes and assert the house edge stays ~4% (target RTP 96%).
import { describe, it, expect } from 'vitest';
import {
  minesSession,
  towerSession,
  stairsSession,
  hiLoSession,
  SessionState,
  RANK_VALUE,
} from './gameSessions';
import { GameConfig } from '../../generated/prisma/client';

const cfg = {
  maxWinMultiplier: 100,
  configJson: {},
  baseRtp: '96.00',
} as unknown as GameConfig;

function stateOf(
  slug: string,
  raw: number,
  choices: Record<string, unknown>,
  force = 'NONE'
): SessionState {
  const logic = {
    mines: minesSession,
    tower: towerSession,
    stairs: stairsSession,
    'hi-lo': hiLoSession,
  }[slug]!;
  const init = logic.init(raw, choices, cfg, force);
  return {
    roundId: 'r',
    slug,
    betAmount: '100',
    clientSeed: 'c',
    nonce: 1,
    rawOutcome: raw,
    status: 'ACTIVE',
    stepIndex: 0,
    currentMultiplier: init.currentMultiplier,
    nextMultiplier: init.nextMultiplier,
    steps: [],
    extra: init.extra,
    configSnapshot: cfg as unknown as Record<string, unknown>,
    forceMode: force,
    demo: false,
    createdAt: Date.now(),
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('session games — RTP under realistic strategies (target ≈96%)', () => {
  it('mines (3 mines): dig until 2× then cashout → ~96% (combinatorial fair ladder)', () => {
    const N = 100_000;
    let total = 0;
    for (let i = 1; i <= N; i++) {
      let st = stateOf('mines', i / (N * 2), { mineCount: 3 });
      let payout = 0;
      // dig tiles in a fixed order until multiplier ≥2 or bust
      for (let tile = 0; tile < 25 && st.status === 'ACTIVE'; tile++) {
        const out = minesSession.step(st, { tile }, cfg)!;
        if (out.terminal) {
          payout = out.next.currentMultiplier > 0 ? out.next.currentMultiplier : 0;
          st = { ...st, ...out.next };
          break;
        }
        st = { ...st, ...out.next };
        if (st.currentMultiplier >= 2) {
          payout = st.currentMultiplier;
          break;
        }
      }
      total += payout;
    }
    const rtp = total / N; // bet=100 → payout units are multipliers
    expect(rtp).toBeGreaterThan(0.9);
    expect(rtp).toBeLessThan(1.02);
  }, 30_000);

  it('mines: the ladder is exactly fair at each level (mult × survival = 0.96)', () => {
    // 1 mine: survival of k safe tiles = (25-k)/25… combinatorial check
    const st = stateOf('mines', 0.123456, { mineCount: 1 });
    const ladder = minesSession.ladder(st);
    for (let k = 1; k <= 5; k++) {
      // fair = C(25,k)/C(24,k) = 25/(25-k)
      const fair = 25 / (25 - k);
      expect(ladder[k - 1]!).toBeCloseTo(0.96 * fair, 1);
    }
  });

  it('mines: digging every safe tile (force win) auto-terminates at max ladder', () => {
    let st = stateOf('mines', 0.123456, { mineCount: 1 }, 'FORCE_WIN');
    const maxSteps = minesSession.maxSteps(st); // 24 safe tiles
    let terminal = false;
    for (let t = 0; t < maxSteps; t++) {
      const out = minesSession.step(st, { tile: t }, cfg)!;
      st = { ...st, ...out.next };
      if (out.terminal) {
        terminal = true;
        break;
      }
    }
    expect(terminal).toBe(true); // last safe tile auto-cashes
    expect(st.currentMultiplier).toBeGreaterThanOrEqual(20);
  });

  it('tower medium: climb 3 floors, random picks → ~96%', () => {
    const N = 200_000;
    let total = 0;
    const rand = rng(42);
    for (let i = 0; i < N; i++) {
      let st = stateOf('tower', rand(), { difficulty: 'medium' });
      let payout = 0;
      for (let f = 0; f < 3 && st.status === 'ACTIVE'; f++) {
        const col = Math.floor(rand() * 4);
        const out = towerSession.step(st, { column: col }, cfg)!;
        if (out.terminal) {
          payout = out.next.currentMultiplier > 0 ? out.next.currentMultiplier : 0;
          break;
        }
        st = { ...st, ...out.next };
        payout = st.currentMultiplier;
      }
      total += payout;
    }
    const rtp = total / N;
    expect(rtp).toBeGreaterThan(0.9);
    expect(rtp).toBeLessThan(1.02);
  });

  it('stairs: 4 safe steps then cashout → ~96%', () => {
    const N = 200_000;
    let total = 0;
    const rand = rng(7);
    for (let i = 0; i < N; i++) {
      let st = stateOf('stairs', rand(), {});
      let payout = 0;
      for (let s = 0; s < 4 && st.status === 'ACTIVE'; s++) {
        const pick = Math.floor(rand() * 2);
        const out = stairsSession.step(st, { pick }, cfg)!;
        if (out.terminal) {
          payout = out.next.currentMultiplier > 0 ? out.next.currentMultiplier : 0;
          break;
        }
        st = { ...st, ...out.next };
        payout = st.currentMultiplier;
      }
      total += payout;
    }
    const rtp = total / N;
    expect(rtp).toBeGreaterThan(0.9);
    expect(rtp).toBeLessThan(1.02);
  });

  it('hi-lo: OPTIMAL first guess (pick the better direction) then cashout → ~97%', () => {
    // Optimal play: guess toward the side with more remaining ranks. EV ≈ 0.97
    // per step. (A fixed "always higher" gets 0.97×12/13 ≈ 0.895 — the Ace
    // first-card case can never win — which is correct casino behavior.)
    const N = 200_000;
    let total = 0;
    for (let i = 1; i <= N; i++) {
      const st = stateOf('hi-lo', i / (N * 3), {});
      const cv = RANK_VALUE[st.extra.currentRank as string] ?? 7;
      const guess = cv <= 8 ? 'higher' : 'lower';
      const out = hiLoSession.step(st, { guess }, cfg)!;
      total += out.terminal ? 0 : out.next.currentMultiplier;
    }
    const rtp = total / N;
    expect(rtp).toBeGreaterThan(0.92);
    expect(rtp).toBeLessThan(1.02);
  });

  it('hi-lo: pushing luck compounds risk — 2 wins then cashout pays less than one', () => {
    // Correct real-casino behavior: each correct guess pays 0.97/prob, but the
    // whole stake is at risk each step, so continuing lowers the realized RTP.
    //
    // NOTE: "always guess higher" is not a legal strategy on an Ace — nothing
    // is higher, so the server now REJECTS that action (it used to quote fake
    // 1.94x odds on an unwinnable bet). Rounds that start on an Ace are skipped
    // here and counted separately.
    const N = 100_000;
    let total = 0;
    let played = 0;
    let rejectedOnAce = 0;
    for (let i = 1; i <= N; i++) {
      let st = stateOf('hi-lo', i / (N * 3), {});
      let payout = 0;
      let legal = true;
      for (let g = 0; g < 2 && st.status === 'ACTIVE'; g++) {
        const out = hiLoSession.step(st, { guess: 'higher' }, cfg);
        if (out === null) {
          legal = false;
          rejectedOnAce++;
          break;
        } // current card is an Ace
        if (out.terminal) {
          payout = 0;
          break;
        }
        st = { ...st, ...out.next };
        payout = st.currentMultiplier;
      }
      if (legal) {
        total += payout;
        played++;
      }
    }
    const rtp = total / played;
    expect(played).toBeGreaterThan(N * 0.5);
    expect(rejectedOnAce).toBeGreaterThan(0); // the guard really does fire
    expect(rtp).toBeGreaterThan(0.5);
    expect(rtp).toBeLessThan(0.85);
  });

  it('hi-lo: an impossible guess is rejected instead of quoting fake odds', () => {
    // Find a round whose opening card is an Ace (nothing higher) or a 2
    // (nothing lower) and confirm the server refuses the unwinnable direction
    // while still accepting the possible one.
    let sawAce = false;
    let sawTwo = false;
    for (let i = 1; i < 5000 && !(sawAce && sawTwo); i++) {
      const st = stateOf('hi-lo', i / 5000, {});
      const rank = (st.extra as { currentRank: string }).currentRank;
      if (rank === 'A') {
        sawAce = true;
        expect(hiLoSession.step(st, { guess: 'higher' }, cfg)).toBeNull();
        expect(hiLoSession.step(st, { guess: 'lower' }, cfg)).not.toBeNull();
      }
      if (rank === '2') {
        sawTwo = true;
        expect(hiLoSession.step(st, { guess: 'lower' }, cfg)).toBeNull();
        expect(hiLoSession.step(st, { guess: 'higher' }, cfg)).not.toBeNull();
      }
    }
    expect(sawAce).toBe(true);
    expect(sawTwo).toBe(true);
  });

  it('invalid steps are rejected (already-dug tile, bad column, bad guess)', () => {
    let st = stateOf('mines', 0.5, { mineCount: 3 });
    const out = minesSession.step(st, { tile: 0 }, cfg)!;
    st = { ...st, ...out.next };
    if (!out.terminal) expect(minesSession.step(st, { tile: 0 }, cfg)).toBeNull(); // duplicate dig
    expect(
      towerSession.step(stateOf('tower', 0.5, {}), { column: 99 }, cfg)
    ).toBeNull();
    expect(stairsSession.step(stateOf('stairs', 0.5, {}), { pick: 5 }, cfg)).toBeNull();
    expect(
      hiLoSession.step(stateOf('hi-lo', 0.5, {}), { guess: 'sideways' }, cfg)
    ).toBeNull();
  });
});
