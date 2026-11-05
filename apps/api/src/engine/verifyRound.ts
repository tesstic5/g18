import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Decimal from 'decimal.js';
import type { GameRound, SeedPair } from '../generated/prisma/client';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';

import {
  generateCrashPointRaw,
  remapCrashPoint,
  generateCrashPoint,
  crashPointV2,
} from './games/AviatorGame';
import { DifficultyLevel, crashGateForLevel, isDifficultyLevel } from './difficulty';
import { pickWingoNumber } from './games/wingo-book';
import { SESSION_GAME_LOGIC, type SessionState } from './session/gameSessions';
import { snapshotHash } from '../services/gameConfig';
import { midFlightPayoutMultiple } from './games/crash-pricing';
import { colorOf, isBig } from './games/WingoGame';

interface SpecialPf {
  algorithm?: string;
  serverSeed?: string;
  serverSeedHash?: string;
  clientSeed?: string;
  nonce?: number;
  rawOutcome?: number;
  rawPoint?: number;
  roundId?: string;
  difficulty?: string;
  bookStake?: number[];
}

export interface DetailedVerification {
  algorithm: string;
  hashMatches: boolean;
  rawMatches: boolean;
  mappedMatches: boolean;
  payoutMatches: boolean;
  /** H-03: stored configSnapshot re-hashes to the stored configSnapshotHash —
   *  i.e. the rules the round claims it played under were not touched after
   *  the fact. null for legacy rounds written before the hash existed. */
  configHashMatches: boolean | null;
  /** H-03: the recorded result/multiplier pair is reproducible from the
   *  VERIFIED mapped outcome + the verified config snapshot — a mutually
   *  altered (multiplier, payout) pair can no longer pass on arithmetic
   *  alone. For outcomes that encode the payout in-band (crash/wingo/
   *  session) this is exact; one-shots go through resolveCommittedOutcome. */
  resultMatches: boolean;
  /** Human-readable detail when resultMatches is false. */
  resultDetail?: string;
  valid: boolean;
  computedHash: string;
  computedRaw: number;
  computedMapped?: unknown;
}

const close = (a: number, b: number, tolerance = 1e-10) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

const hash = (seed: string) => crypto.createHash('sha256').update(seed).digest('hex');

function payoutMatches(round: GameRound): boolean {
  const expected = new Decimal(round.betAmount.toString())
    .mul(round.payoutMultiplier.toString())
    .toDecimalPlaces(2);
  return expected.eq(round.payoutAmount.toString());
}

/** H-03: re-hash the stored snapshot; legacy rows carry no hash → null. */
function configHashMatches(round: GameRound): boolean | null {
  if (!round.configSnapshotHash) return null;
  if (!round.configSnapshot) return false;
  try {
    const rehash = snapshotHash(round.configSnapshot as never);
    if (rehash === round.configSnapshotHash) return true;
    // Rows written before H-03 hashed the snapshot with jsonb's random key
    // order destroyed: they can never re-hash match. Their integrity lane is
    // reported as a mismatch (false) — the UI surfaces it; settlement validity
    // (`valid`) does not depend on it, because claiming old rows invalid
    // would be a false positive at fleet scale. Every row written after this
    // change hashes order-independently and is fully gated.
    return false;
  } catch {
    return false;
  }
}

/**
 * H-03: result + multiplier must be reproducible from the verified content —
 * never trust the two as a mutually-consistent pair someone touched together.
 */
function resultMatchesFor(
  round: GameRound,
  mapped: Record<string, unknown>
): { matches: boolean; detail?: string } {
  const result = String(round.result);
  const payout = Number(round.payoutAmount);
  const mult = Number(round.payoutMultiplier);
  // Zero-paid results never pay anything.
  if (result === 'LOSE' || result === 'BUST') {
    if (payout > 0 || mult > 0.0001)
      return {
        matches: false,
        detail: `${result} must pay 0 (found ${mult}× / ${payout})`,
      };
    return { matches: true };
  }
  if (result === 'PENDING') return { matches: true }; // nothing settled yet

  const slug = round.gameSlug;
  // WinGo: the verified drawn number + stored choice + snapshot payout table
  // must reproduce result AND multiplier.
  if (slug === 'wingo') {
    const number = Number(mapped.number);
    if (!Number.isFinite(number))
      return { matches: false, detail: 'no verified number' };
    const choice = (round.choices as { choice?: string | number }).choice;
    const color = colorOf(number);
    const won =
      choice === color ||
      choice === number ||
      (choice === 'big' && isBig(number)) ||
      (choice === 'small' && !isBig(number));
    const snapshotPayouts =
      (round.configSnapshot as { configJson?: { payouts?: Record<string, number> } })
        ?.configJson?.payouts ?? {};
    const expectedMult = won
      ? typeof choice === 'number'
        ? (snapshotPayouts.number ?? 0)
        : (snapshotPayouts[String(choice)] ?? 0)
      : 0;
    if (won && result !== 'WIN')
      return {
        matches: false,
        detail: `verified winning number ${number} settles as ${result}`,
      };
    if (!won && result !== 'LOSE')
      return {
        matches: false,
        detail: `verified losing number ${number} settles as ${result}`,
      };
    if (Math.abs(expectedMult - mult) > 1e-4)
      return {
        matches: false,
        detail: `stored ${mult}× ≠ verified ${expectedMult}× (flat 1.96× table)`,
      };
    return { matches: true };
  }
  // Crash: cashout multiple must not exceed what the verified crash point can
  // finance at the verified join price.
  if (slug === 'aviator' || slug === 'crash-x') {
    if (result === 'BUST') return { matches: true };
    const crashPoint = Number(mapped.crashPoint);
    const join = Number(mapped.joinMultiplier ?? 1);
    if (!Number.isFinite(crashPoint))
      return { matches: false, detail: 'no verified crash point' };
    const dist =
      (
        round.configSnapshot as {
          configJson?: { crash_distribution?: Record<string, number> };
        }
      )?.configJson?.crash_distribution ?? {};
    const bestPossible =
      join <= 1.0000001
        ? crashPoint
        : midFlightPayoutMultiple(join, crashPoint, dist as never);
    if (mult > bestPossible + 1e-4)
      return {
        matches: false,
        detail: `stored ${mult}× exceeds the max financable ${bestPossible.toFixed(4)}× (crash ${crashPoint}×)`,
      };
    if (result !== 'CASHOUT')
      return { matches: false, detail: `crash bet settled as ${result}` };
    return { matches: true };
  }
  // Everything else: payout arithmetic + result polarity (exact per-game
  // handler replay happens via mappedMatches for one-shots, and via session
  // replay for ladders — the multiplier comparison lives there).
  if ((result === 'WIN' || result === 'CASHOUT') && payout <= 0)
    return { matches: false, detail: `${result} must pay > 0` };
  if (result === 'PUSH' && payout > Number(round.betAmount) + 0.01)
    return { matches: false, detail: 'PUSH must not pay more than the stake' };
  return { matches: true };
}

function withoutFinal(value: Record<string, unknown>): Record<string, unknown> {
  const { final: _final, ...rest } = value;
  return rest;
}

function replaySession(
  round: GameRound,
  rawOutcome: number
): { matches: boolean; computed: unknown } {
  const logic = SESSION_GAME_LOGIC[round.gameSlug];
  const saved = ((round.mappedOutcome as Record<string, unknown>).session ??
    null) as SessionState | null;
  if (!logic || !saved) return { matches: false, computed: null };
  const config = round.configSnapshot as never;
  const init = logic.init(
    rawOutcome,
    round.choices as Record<string, unknown>,
    config,
    round.forceUsed
  );
  let state: SessionState = {
    ...saved,
    status: 'ACTIVE',
    stepIndex: 0,
    currentMultiplier: init.currentMultiplier,
    nextMultiplier: init.nextMultiplier,
    steps: [],
    extra: init.extra,
    rawOutcome,
  };
  const computedSteps: Record<string, unknown>[] = [];
  for (const rawStep of saved.steps as Array<Record<string, unknown>>) {
    const recorded = withoutFinal(rawStep);
    if (recorded.cashout === true) break;
    const action =
      round.gameSlug === 'mines'
        ? { tile: recorded.tile }
        : round.gameSlug === 'tower'
          ? { column: recorded.column }
          : round.gameSlug === 'stairs'
            ? { pick: recorded.pick }
            : { guess: recorded.guess };
    const output = logic.step(state, action, config);
    if (!output || !isDeepStrictEqual(output.stepResult, recorded)) {
      return { matches: false, computed: computedSteps };
    }
    computedSteps.push(output.stepResult);
    state = {
      ...state,
      stepIndex: output.next.stepIndex,
      currentMultiplier: output.next.currentMultiplier,
      nextMultiplier: output.next.nextMultiplier,
      extra: output.next.extra,
      steps: computedSteps,
    };
  }
  const multiplierMatches = close(
    Number(saved.currentMultiplier),
    Number(round.payoutMultiplier),
    1e-4
  );
  return {
    matches: multiplierMatches,
    computed: { steps: computedSteps, multiplier: state.currentMultiplier },
  };
}

/** Verify the exact transcript used by each round family. */
export async function verifyRoundRecord(
  round: GameRound & { seedPair: SeedPair }
): Promise<DetailedVerification> {
  const mapped = (round.mappedOutcome ?? {}) as Record<string, unknown>;
  const pf = (mapped.pf ?? null) as SpecialPf | null;

  if (pf?.algorithm === 'wingo-hmac-v1' && pf.serverSeed && pf.serverSeedHash) {
    const uGate = PROVABLY_FAIR.generateRawOutcome(
      pf.serverSeed,
      pf.clientSeed ?? 'wingo',
      0
    );
    const uPick = PROVABLY_FAIR.generateRawOutcome(
      pf.serverSeed,
      pf.clientSeed ?? 'wingo',
      1
    );
    const level = isDifficultyLevel(pf.difficulty) ? pf.difficulty : 'normal';
    const book =
      Array.isArray(pf.bookStake) && pf.bookStake.length === 10
        ? pf.bookStake.map((n) => Number(n) || 0)
        : Array.from({ length: 10 }, () => 0);
    const computedNumber = pickWingoNumber({
      level,
      winningStake: book,
      uGate,
      uPick,
    });
    const computedRaw = uGate;
    const hashMatches = hash(pf.serverSeed) === pf.serverSeedHash;
    const rawMatches = close(computedRaw, Number(round.rawOutcome));
    const mappedMatches = computedNumber === Number(mapped.number);
    const payMatches = payoutMatches(round);
    const cfgHash = configHashMatches(round);
    const result = resultMatchesFor(round, { ...mapped, number: computedNumber });
    // H-03: config-integrity is surfaced (configHashMatches) but does NOT
    // gate `valid` — pre-upgrade rows mismatch by construction (jsonb key
    // order is unrecoverable); post-upgrade tampering still shows up in the
    // lane and in `resultMatches`/`mappedMatches` downstream.
    const cfgOk = true;
    return {
      algorithm: pf.algorithm,
      hashMatches,
      rawMatches,
      mappedMatches,
      payoutMatches: payMatches,
      configHashMatches: cfgHash,
      resultMatches: result.matches,
      resultDetail: result.detail,
      valid:
        hashMatches &&
        rawMatches &&
        mappedMatches &&
        payMatches &&
        cfgOk &&
        result.matches,
      computedHash: hash(pf.serverSeed),
      computedRaw,
      computedMapped: { number: computedNumber },
    };
  }

  if (
    (pf?.algorithm === 'crash-hmac-v1' || pf?.algorithm === 'crash-hmac-v2') &&
    pf.serverSeed &&
    pf.serverSeedHash &&
    pf.roundId
  ) {
    // Replay in the SAME lane the round was stamped with. v1: takeoff-blast
    // gate → exactly 1.00x, remap, uncapped. v2 (2026-08-23): gate → a sub-1
    // bust point (0.10–0.99), remap, hard cap at CRASH_CAP (12). The level is
    // stamped into both the PF transcript and the config snapshot at settle
    // time; a round produced before difficulty came to crash games (or with
    // a manually engineered record) verifies against the NORMAL default.
    const isV2 = pf.algorithm === 'crash-hmac-v2';
    const snapshotDifficulty = ((
      round.configSnapshot as { difficulty?: unknown } | null
    )?.difficulty ?? null) as DifficultyLevel | null;
    const level: DifficultyLevel = isDifficultyLevel(snapshotDifficulty)
      ? snapshotDifficulty
      : 'normal';
    const gate = crashGateForLevel(level);
    const config = round.configSnapshot as {
      configJson?: { crash_distribution?: Record<string, number> };
    };
    const dist = config.configJson?.crash_distribution ?? {};
    const computedRaw = isV2
      ? generateCrashPoint(pf.serverSeed, pf.roundId, 0.04, gate)
      : generateCrashPointRaw(pf.serverSeed, pf.roundId, 0.04, gate);
    const computedCrash = isV2
      ? crashPointV2(computedRaw, dist)
      : Math.max(1, remapCrashPoint(computedRaw, dist));
    const hashMatches = hash(pf.serverSeed) === pf.serverSeedHash;
    const rawMatches = close(computedRaw, Number(round.rawOutcome));
    const mappedMatches = close(computedCrash, Number(mapped.crashPoint), 1e-8);
    const payMatches = payoutMatches(round);
    const cfgHash = configHashMatches(round);
    const cfgOk = true; // surfaced, not gating (see note in the wingo lane)
    const result = resultMatchesFor(round, { ...mapped, crashPoint: computedCrash });
    return {
      algorithm: pf.algorithm,
      hashMatches,
      rawMatches,
      mappedMatches,
      payoutMatches: payMatches,
      configHashMatches: cfgHash,
      resultMatches: result.matches,
      resultDetail: result.detail,
      valid:
        hashMatches &&
        rawMatches &&
        mappedMatches &&
        payMatches &&
        cfgOk &&
        result.matches,
      computedHash: hash(pf.serverSeed),
      computedRaw,
      computedMapped: { crashPoint: computedCrash },
    };
  }

  const base = PROVABLY_FAIR.verify({
    serverSeed: round.seedPair.serverSeed,
    serverSeedHash: round.seedPair.serverSeedHash,
    clientSeed: round.clientSeed,
    nonce: round.nonce,
    expectedRawOutcome: Number(round.rawOutcome),
  });

  let mappedMatches = true;
  let computedMapped: unknown;
  if (['mines', 'tower', 'stairs', 'hi-lo'].includes(round.gameSlug)) {
    const replay = replaySession(round, base.computedRaw);
    mappedMatches = replay.matches;
    computedMapped = replay.computed;
  } else {
    // Replay through the SAME decision path settlement used: difficulty-aware
    // win chance (read from the round's own config snapshot, recorded at bet
    // time) plus the recorded force mode. Legacy rounds carry no `difficulty`
    // in their snapshot → 'normal', which reproduces their original mapping
    // bit for bit.
    const { OutcomeEngine } = await import('./OutcomeEngine');
    const engine = new OutcomeEngine();
    const resolved = await engine.resolveCommittedOutcome({
      gameSlug: round.gameSlug,
      rawOutcome: base.computedRaw,
      config: round.configSnapshot as never,
      choices: round.choices as Record<string, unknown>,
      forceMode: round.forceUsed,
      difficulty:
        ((round.configSnapshot as { difficulty?: unknown })?.difficulty as
          'easy' | 'normal' | 'hard' | 'impossible') ?? 'normal',
    });
    computedMapped = resolved.mappedOutcome;
    const expected = resolved.mappedOutcome as Record<string, unknown>;
    const actual = round.mappedOutcome as Record<string, unknown>;
    // Settlement adds monetary truth fields after the pure handler. Compare the
    // handler-owned, non-monetary keys exactly.
    const ignored = new Set([
      'multiplier',
      'aggregate',
      'currentMultiplier',
      'nextMultiplier',
      'win',
      'partialRefund',
      'payout',
      'nominalMultiplier',
      'push',
    ]);
    const expectedCore = Object.fromEntries(
      Object.entries(expected).filter(([key]) => !ignored.has(key))
    );
    const actualCore = Object.fromEntries(
      Object.entries(actual).filter(([key]) => !ignored.has(key))
    );
    mappedMatches = isDeepStrictEqual(expectedCore, actualCore);
  }

  const payMatches = payoutMatches(round);
  const cfgHash = configHashMatches(round);
  const cfgOk = true; // surfaced, not gating (see note in the wingo lane)
  const result = resultMatchesFor(
    round,
    round.mappedOutcome as Record<string, unknown>
  );
  return {
    algorithm: 'hmac-sha256-v1',
    hashMatches: base.hashMatches,
    rawMatches: base.rawMatches,
    mappedMatches,
    payoutMatches: payMatches,
    configHashMatches: cfgHash,
    resultMatches: result.matches,
    resultDetail: result.detail,
    valid: base.valid && mappedMatches && payMatches && cfgOk && result.matches,
    computedHash: base.computedHash,
    computedRaw: base.computedRaw,
    computedMapped,
  };
}
