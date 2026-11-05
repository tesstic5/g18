// apps/api/src/engine/session/gameSessions.ts — session logic for multi-step games
// (D-092). REAL gameplay loop: ONE bet per round; each step raises the multiplier;
// cash out anytime. Replaces the old per-step betting where every dig/climb/guess
// was a NEW wallet deduction (the #1 flow bug users felt).
//
// Determinism: every step derives from the round's committed rawOutcome via
// mulberry32(seed + stepIndex) — provably fair, replayable, server-truth.
import { mulberry32 } from '../games/MinesGame';
import { GameConfig } from '../../generated/prisma/client';
import {
  TOWER_FLOORS as SHARED_TOWER_FLOORS,
  fairTowerLadder,
  resolveTowerBoard,
} from '@casino/shared';

export interface SessionState {
  roundId: string;
  slug: string;
  betAmount: string; // decimal string — charged ONCE at creation
  clientSeed: string;
  nonce: number;
  rawOutcome: number; // committed at creation (PF: seed hash revealed later)
  status: 'ACTIVE' | 'CASHOUT' | 'BUST';
  stepIndex: number; // completed steps
  currentMultiplier: number; // bet × this = payout on cashout
  nextMultiplier: number; // what the next safe step pays
  steps: unknown[]; // visible step results (what the player saw)
  extra: Record<string, unknown>; // SERVER-ONLY hidden state (mines, traps, ladder…)
  configSnapshot: Record<string, unknown>; // game config at session start (ladders, caps)
  forceMode: string;
  demo: boolean;
  createdAt: number;
  /**
   * Which wallets funded the stake, as decimal strings (persisted as JSON).
   * The cashout credits these same wallets pro rata so bonus/gifted funds can
   * never be converted into withdrawable REAL balance. Optional for backward
   * compatibility with sessions created before this field existed.
   */
  deductedFrom?: Array<{
    type: 'REAL' | 'BONUS' | 'GIFTED' | 'LOCKED';
    amount: string;
  }>;
}

export interface StepOutcome {
  stepResult: Record<string, unknown>; // what the client reveals/animates
  terminal: boolean; // round finished (bust or auto-cashout)
  next: {
    extra: Record<string, unknown>;
    currentMultiplier: number;
    nextMultiplier: number;
    stepIndex: number;
  };
}

export interface SessionGameLogic {
  slug: string;
  /** Build the initial hidden state + first multipliers from the committed rawOutcome. */
  init(
    rawOutcome: number,
    choices: Record<string, unknown>,
    config: GameConfig,
    forceMode: string
  ): {
    extra: Record<string, unknown>;
    currentMultiplier: number;
    nextMultiplier: number;
  };
  /** Advance one step. Return null for an invalid action (client error). */
  step(
    state: SessionState,
    action: Record<string, unknown>,
    config: GameConfig
  ): StepOutcome | null;
  /** Max steps before the round auto-cashes (safety + auto-win). */
  maxSteps(state: SessionState): number;
  /** Ladder of multipliers per completed step (used for cashout values). */
  ladder(state: SessionState): number[];
}

// ────────────────────────────── MINES ─────────────────────────────────────
// 5×5 grid, choose 1–24 mines. After k+1 safe tiles the multiplier pays
// 0.96 × C(25, k+1)/C(25−m, k+1) — the TRUE survival odds for m mines, so
// cashing out at any level is fair at 96% RTP. (The old geometric ladder
// made 2× unreachable — 14 digs for a ~8% survival chance.)
const MINES_GRID = 25;
export function minesLadder(mineCount: number): number[] {
  const m = Math.min(24, Math.max(1, mineCount));
  const arr: number[] = [];
  for (let k = 1; k <= MINES_GRID - m; k++) {
    // C(25,k) / C(25-m,k) — survival probability of digging k safe tiles
    let fair = 1;
    for (let j = 0; j < k; j++) fair *= (MINES_GRID - j) / (MINES_GRID - m - j);
    arr.push(+(0.96 * fair).toFixed(2));
  }
  return arr; // arr[k-1] = multiplier after k safe tiles
}
function minesCfgLadder(config: GameConfig, mineCount: number): number[] {
  const ladders = (config.configJson as { payout_ladders?: Record<string, number[]> })
    .payout_ladders;
  return ladders?.[String(mineCount)] ?? minesLadder(mineCount);
}

export const minesSession: SessionGameLogic = {
  slug: 'mines',
  init(rawOutcome, choices, config, forceMode) {
    const mineCount = Math.min(24, Math.max(1, Number(choices.mineCount ?? 3)));
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const mines = new Set<number>();
    if (forceMode !== 'FORCE_WIN') {
      while (mines.size < mineCount) mines.add(Math.floor(rng() * MINES_GRID));
    }
    const ladder = minesCfgLadder(config, mineCount);
    return {
      extra: {
        gridSize: MINES_GRID,
        mineCount,
        mines: [...mines],
        revealed: [] as number[],
      },
      currentMultiplier: 1,
      nextMultiplier: ladder[0] ?? 1,
    };
  },
  maxSteps(state) {
    const { gridSize, mineCount } = state.extra as {
      gridSize: number;
      mineCount: number;
    };
    return gridSize - mineCount; // digging every safe tile auto-cashes
  },
  ladder(state) {
    const { mineCount } = state.extra as { mineCount: number };
    return minesCfgLadder(state.configSnapshot as GameConfig, mineCount);
  },
  step(state, action, config) {
    const { gridSize, mineCount, mines, revealed } = state.extra as {
      gridSize: number;
      mineCount: number;
      mines: number[];
      revealed: number[];
    };
    const tile = Number(action.tile);
    if (
      !Number.isInteger(tile) ||
      tile < 0 ||
      tile >= gridSize ||
      revealed.includes(tile)
    )
      return null;
    const ladder = minesCfgLadder(config, mineCount);
    const isMine = mines.includes(tile);

    if (isMine || state.forceMode === 'FORCE_LOSE') {
      return {
        stepResult: {
          tile,
          safe: false,
          isMine: true,
          minePositions: [...mines], // revealed only on bust
          revealedSafeTiles: revealed,
        },
        terminal: true,
        next: {
          extra: state.extra,
          currentMultiplier: 0,
          nextMultiplier: 0,
          stepIndex: state.stepIndex + 1,
        },
      };
    }
    const nextRevealed = [...revealed, tile];
    const k = nextRevealed.length; // safe tiles dug
    const mult = Math.min(
      ladder[Math.min(k - 1, ladder.length - 1)] ?? 1,
      Number(config.maxWinMultiplier)
    );
    const nextMult = Math.min(
      ladder[Math.min(k, ladder.length - 1)] ?? mult,
      Number(config.maxWinMultiplier)
    );
    const extra = { ...state.extra, revealed: nextRevealed };
    const terminal = k >= gridSize - mineCount; // all safe tiles dug → auto-win
    return {
      stepResult: {
        tile,
        safe: true,
        isMine: false,
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        safeCount: k,
      },
      terminal,
      next: {
        extra,
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        stepIndex: state.stepIndex + 1,
      },
    };
  },
};

// ────────────────────────────── TOWER ─────────────────────────────────────
const TOWER_FLOORS = SHARED_TOWER_FLOORS;

/**
 * Fair ladder for a tower: each floor the player picks 1 of `cols` columns and
 * `traps` of them are fatal, so P(survive one floor) = (cols - traps) / cols.
 * After f floors the survival chance is that value to the power f, and a fair
 * payout is 0.96 / P(survive f).
 *
 * This is the NO-CONFIG fallback. Live play prefers admin
 * `payout_ladder_{difficulty}` / `difficulties[id].payout_ladder` (see
 * `resolveTowerBoard`). The old hard-coded table FLATLINED at 100x — on
 * `hard` floor 10 that was 0.01% RTP.
 */
export function towerLadder(
  cols: number,
  traps: number,
  floors = TOWER_FLOORS
): number[] {
  return fairTowerLadder(cols, traps, floors);
}

function towerDiff(config: GameConfig, difficulty: string) {
  // Nested difficulties[id].payout_ladder wins, then top-level
  // payout_ladder_{id}, then the fair formula. A short ladder is ignored
  // (never silently clamped — that was the 0.01% RTP bug).
  return resolveTowerBoard(config.configJson, difficulty);
}

export const towerSession: SessionGameLogic = {
  slug: 'tower',
  init(rawOutcome, choices, config, forceMode) {
    const difficulty = String(choices.difficulty ?? 'medium');
    const { cols, traps, ladder } = towerDiff(config, difficulty);
    // traps per floor — deterministic from rawOutcome + floor
    const trapsByFloor: number[][] = [];
    for (let f = 0; f < TOWER_FLOORS; f++) {
      const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff) + f);
      const set = new Set<number>();
      if (forceMode !== 'FORCE_WIN')
        while (set.size < traps) set.add(Math.floor(rng() * cols));
      trapsByFloor.push([...set]);
    }
    return {
      extra: { difficulty, cols, trapsPerFloor: traps, trapsByFloor, floor: 0 },
      currentMultiplier: 1,
      nextMultiplier: ladder[0] ?? 1,
    };
  },
  maxSteps() {
    return TOWER_FLOORS;
  },
  ladder(state) {
    const { difficulty } = state.extra as { difficulty: string };
    return towerDiff(state.configSnapshot as GameConfig, difficulty).ladder;
  },
  step(state, action, config) {
    const { difficulty, cols, trapsByFloor, floor } = state.extra as {
      difficulty: string;
      cols: number;
      trapsByFloor: number[][];
      floor: number;
    };
    const column = Number(action.column);
    if (!Number.isInteger(column) || column < 0 || column >= cols) return null;
    const { ladder } = towerDiff(config, difficulty);
    const traps = trapsByFloor[floor] ?? [];
    const safe =
      state.forceMode === 'FORCE_WIN'
        ? true
        : state.forceMode === 'FORCE_LOSE'
          ? false
          : !traps.includes(column);

    if (!safe) {
      return {
        stepResult: { floor, column, safe: false, trapPositions: traps, columns: cols },
        terminal: true,
        next: {
          extra: state.extra,
          currentMultiplier: 0,
          nextMultiplier: 0,
          stepIndex: state.stepIndex + 1,
        },
      };
    }
    const nextFloor = floor + 1;
    const mult = Math.min(
      ladder[Math.min(nextFloor - 1, ladder.length - 1)] ?? 1,
      Number(config.maxWinMultiplier)
    );
    const nextMult = Math.min(
      ladder[Math.min(nextFloor, ladder.length - 1)] ?? mult,
      Number(config.maxWinMultiplier)
    );
    const terminal = nextFloor >= TOWER_FLOORS; // top reached → auto-win
    return {
      stepResult: {
        floor,
        column,
        safe: true,
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        floorReached: nextFloor,
        columns: cols,
      },
      terminal,
      next: {
        extra: { ...state.extra, floor: nextFloor },
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        stepIndex: state.stepIndex + 1,
      },
    };
  },
};

// ────────────────────────────── STAIRS ────────────────────────────────────
const STAIRS_STEPS = 10;

/**
 * Fair stairs ladder: each step the player picks 1 of `choices` doors and
 * `safePer` of them are safe, so a fair payout after n steps is
 * 0.96 / (safePer / choices)^n.
 *
 * Same flatline bug as Tower: the hard-coded ladder stopped at 100x from step
 * 7 on, where fair is 122.88x, 245.76x, 491.52x and 983.04x — the last step
 * paid 9.8% RTP.
 */
export function stairsLadder2(
  choices = 2,
  safePer = 1,
  steps = STAIRS_STEPS
): number[] {
  const p = Math.max(0.01, Math.min(0.99, safePer / choices));
  const out: number[] = [];
  for (let n = 1; n <= steps; n++) out.push(+(0.96 / Math.pow(p, n)).toFixed(2));
  return out;
}

function stairsLadder(config: GameConfig): number[] {
  const cfg = config.configJson as {
    payout_ladder?: number[];
    choices_per_step?: number;
    safe_per_step?: number;
  };
  const configured = cfg.payout_ladder;
  if (Array.isArray(configured) && configured.length >= STAIRS_STEPS) return configured;
  return stairsLadder2(cfg.choices_per_step ?? 2, cfg.safe_per_step ?? 1);
}

export const stairsSession: SessionGameLogic = {
  slug: 'stairs',
  init(_rawOutcome, _choices, config, _forceMode) {
    return {
      extra: { step: 0, choices: 2, safePerStep: 1 },
      currentMultiplier: 1,
      nextMultiplier: stairsLadder(config)[0] ?? 1,
    };
  },
  maxSteps() {
    return STAIRS_STEPS;
  },
  ladder(state) {
    return stairsLadder(state.configSnapshot as GameConfig);
  },
  step(state, action, config) {
    const { step } = state.extra as { step: number };
    const pick = Number(action.pick);
    if (pick !== 0 && pick !== 1) return null;
    const safePer = (state.extra as { safePerStep?: number }).safePerStep ?? 1;
    const choicesN = (state.extra as { choices?: number }).choices ?? 2;
    const rng = mulberry32(Math.floor(state.rawOutcome * 0xffffffff) + step);
    const safe =
      state.forceMode === 'FORCE_WIN'
        ? true
        : state.forceMode === 'FORCE_LOSE'
          ? false
          : rng() < safePer / choicesN;
    const ladder = stairsLadder(config);

    if (!safe) {
      return {
        stepResult: { step, pick, safe: false },
        terminal: true,
        next: {
          extra: state.extra,
          currentMultiplier: 0,
          nextMultiplier: 0,
          stepIndex: state.stepIndex + 1,
        },
      };
    }
    const nextStep = step + 1;
    const mult = Math.min(
      ladder[Math.min(nextStep - 1, ladder.length - 1)] ?? 1,
      Number(config.maxWinMultiplier)
    );
    const nextMult = Math.min(
      ladder[Math.min(nextStep, ladder.length - 1)] ?? mult,
      Number(config.maxWinMultiplier)
    );
    const terminal = nextStep >= STAIRS_STEPS;
    return {
      stepResult: {
        step,
        pick,
        safe: true,
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        stepReached: nextStep,
      },
      terminal,
      next: {
        extra: { ...state.extra, step: nextStep },
        currentMultiplier: mult,
        nextMultiplier: nextMult,
        stepIndex: state.stepIndex + 1,
      },
    };
  },
};

// ────────────────────────────── HI-LO ─────────────────────────────────────
const RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const;
export const RANK_VALUE: Record<string, number> = Object.fromEntries(
  RANKS.map((r, i) => [r, i + 2])
);
const SUITS = ['♠', '♥', '♦', '♣'];

export function cardFromRaw(raw: number, offset = 0): { rank: string; suit: string } {
  const rng = mulberry32(Math.floor(raw * 0xffffffff) + offset);
  const idx = Math.floor(rng() * 52);
  return { rank: RANKS[Math.floor(idx / 4)]!, suit: SUITS[idx % 4]! };
}

export const hiLoSession: SessionGameLogic = {
  slug: 'hi-lo',
  init(rawOutcome, _choices, _config, _forceMode) {
    const first = cardFromRaw(rawOutcome, 0);
    return {
      extra: { currentRank: first.rank, currentSuit: first.suit, streak: 0, mult: 1 },
      currentMultiplier: 1,
      // honest "next step" preview: 0.97 / best-guess probability (0.97/E[p] ≈ 2.1)
      nextMultiplier: 2.1,
    };
  },
  maxSteps() {
    return 30;
  }, // safety cap — players may keep guessing
  ladder() {
    return [];
  },
  step(state, action, config) {
    const guess = String(action.guess ?? '');
    if (guess !== 'higher' && guess !== 'lower') return null;
    const { currentRank, currentSuit, streak, mult } = state.extra as {
      currentRank: string;
      currentSuit: string;
      streak: number;
      mult: number;
    };
    const next = cardFromRaw(state.rawOutcome, streak + 1);
    const cv = RANK_VALUE[currentRank] ?? 7;
    const nv = RANK_VALUE[next.rank] ?? 7;
    const won = guess === 'higher' ? nv > cv : nv < cv; // tie = lose (real rules)
    const above = (14 - cv) * 4,
      below = (cv - 2) * 4;
    const prob = (guess === 'higher' ? above : below) / 52;

    // IMPOSSIBLE GUESS GUARD.
    // On an Ace nothing is higher and on a 2 nothing is lower, so `prob` is 0.
    // The old code did `0.97 / (prob || 0.5)`, which turned a guaranteed loss
    // into an advertised 1.94x bet — the player was shown odds for a wager that
    // could never be won. Reject the action instead (the client offers only the
    // possible direction; this is the server-side backstop).
    if (prob <= 0) return null;

    const stepMult = 0.97 / prob;
    const newMult = won
      ? Math.min(mult * stepMult, Number(config.maxWinMultiplier))
      : 0;

    if (!won) {
      return {
        stepResult: {
          current: currentRank,
          currentSuit,
          next: next.rank,
          suit: next.suit,
          guess,
          win: false,
          probability: +(prob * 100).toFixed(1),
        },
        terminal: true,
        next: {
          extra: state.extra,
          currentMultiplier: 0,
          nextMultiplier: 0,
          stepIndex: state.stepIndex + 1,
        },
      };
    }
    const nv2 = RANK_VALUE[next.rank] ?? 7;
    // Best-guess probability with the NEW card, in the same /52 units the
    // payout uses. `/13` was wrong here: `above`/`below` are counted in cards
    // (x4 suits) out of 52, so dividing the rank gap by 13 happens to give the
    // same ratio — but state it explicitly so the preview cannot drift.
    const pBest = Math.max((14 - nv2) * 4, (nv2 - 2) * 4) / 52;
    return {
      stepResult: {
        current: currentRank,
        currentSuit,
        next: next.rank,
        suit: next.suit,
        guess,
        win: true,
        probability: +(prob * 100).toFixed(1),
        multiplier: +newMult.toFixed(2),
      },
      terminal: false,
      next: {
        extra: {
          currentRank: next.rank,
          currentSuit: next.suit,
          streak: streak + 1,
          mult: newMult,
        },
        currentMultiplier: +newMult.toFixed(2),
        nextMultiplier: +Math.min(
          newMult * (0.97 / (pBest || 0.5)),
          Number(config.maxWinMultiplier)
        ).toFixed(2),
        stepIndex: state.stepIndex + 1,
      },
    };
  },
};

export const SESSION_GAME_LOGIC: Record<string, SessionGameLogic> = {
  mines: minesSession,
  tower: towerSession,
  stairs: stairsSession,
  'hi-lo': hiLoSession,
};
export const SESSION_GAMES = Object.keys(SESSION_GAME_LOGIC);
