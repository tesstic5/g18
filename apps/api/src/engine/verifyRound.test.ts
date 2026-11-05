import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import { verifyRoundRecord } from './verifyRound';
import { drawNumber, colorOf } from './games/WingoGame';
import { generateCrashPointRaw, remapCrashPoint } from './games/AviatorGame';
import { generateCrashPoint, crashPointV2 } from './games/AviatorGame';
import { crashGateForLevel } from './difficulty';
import { minesSession, type SessionState } from './session/gameSessions';

const seedPair = (serverSeed: string) =>
  ({
    id: 'seed',
    userId: 'u',
    serverSeed,
    serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
    clientSeed: 'unused',
    nonce: 0,
    status: 'REVEALED',
    createdAt: new Date(),
    revealedAt: new Date(),
  }) as never;

const base = {
  id: 'r',
  userId: 'u',
  betAmount: new Decimal(10),
  walletTypeUsed: 'REAL',
  requestId: 'req',
  choices: {},
  payoutAmount: new Decimal(0),
  payoutMultiplier: new Decimal(0),
  rawOutcome: new Decimal(0),
  result: 'LOSE',
  forceUsed: 'NONE',
  demo: false,
  createdAt: new Date(),
  configSnapshotHash: 'hash',
  seedPairId: 'seed',
} as const;

describe('verifyRoundRecord shared-round transcripts', () => {
  it('reproduces a WinGo number and payout', async () => {
    const serverSeed = 'a'.repeat(64);
    const raw = PROVABLY_FAIR.generateRawOutcome(serverSeed, 'wingo', 0);
    const weights = Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }));
    const number = drawNumber(raw, weights);
    const choice = colorOf(number); // a colour bet that this number wins
    const round = {
      ...base,
      gameSlug: 'wingo',
      clientSeed: 'wingo',
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'WIN',
      choices: { choice },
      payoutMultiplier: new Decimal(1.96),
      payoutAmount: new Decimal(19.6),
      configSnapshot: {
        configJson: {
          number_weights: weights,
          payouts: {
            red: 1.96,
            green: 1.96,
            violet: 1.96,
            number: 1.96,
            big: 1.96,
            small: 1.96,
          },
        },
      },
      mappedOutcome: {
        number,
        multiplier: 1.96,
        pf: {
          algorithm: 'wingo-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          clientSeed: 'wingo',
          nonce: 0,
          rawOutcome: raw,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const result = await verifyRoundRecord(round);
    expect(result).toMatchObject({
      valid: true,
      hashMatches: true,
      rawMatches: true,
      mappedMatches: true,
      payoutMatches: true,
    });
  });

  it('reproduces a crash point', async () => {
    const serverSeed = 'b'.repeat(64);
    const roundId = 'round-1';
    const distribution = { '1.00-2.00': 50, '2.00-10.00': 50 };
    const raw = generateCrashPointRaw(serverSeed, roundId, 0.04);
    const crashPoint = Math.max(1, remapCrashPoint(raw, distribution));
    const round = {
      ...base,
      gameSlug: 'aviator',
      clientSeed: `crash:${roundId}`,
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'BUST',
      configSnapshot: { configJson: { crash_distribution: distribution } },
      mappedOutcome: {
        crashPoint,
        pf: {
          algorithm: 'crash-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          roundId,
          rawPoint: raw,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const result = await verifyRoundRecord(round);
    expect(result).toMatchObject({
      valid: true,
      hashMatches: true,
      rawMatches: true,
      mappedMatches: true,
      payoutMatches: true,
    });
  });

  it('reproduces a v2 crash point (sub-1 gate + 12x cap lane)', async () => {
    // crash-hmac-v2 (2026-08-23): gate rounds replay to the stored SUB-1
    // bust point; flights replay through the capped remap. A v1 replay of
    // v2 bytes must NOT match (lanes are cross-checked below).
    const serverSeed = 'b'.repeat(64);
    const roundId = 'round-v2-1';
    const distribution = { '1.00-2.00': 50, '2.00-10.00': 50 };
    const raw = generateCrashPoint(serverSeed, roundId, 0.04);
    const crashPoint = crashPointV2(raw, distribution);
    const round = {
      ...base,
      gameSlug: 'aviator',
      clientSeed: `crash:${roundId}`,
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'BUST',
      configSnapshot: { configJson: { crash_distribution: distribution } },
      mappedOutcome: {
        crashPoint,
        pf: {
          algorithm: 'crash-hmac-v2',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          roundId,
          rawPoint: raw,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const result = await verifyRoundRecord(round);
    expect(result).toMatchObject({
      valid: true,
      hashMatches: true,
      rawMatches: true,
      mappedMatches: true,
      payoutMatches: true,
    });
    expect(crashPoint).toBeLessThanOrEqual(12); // cap is part of the lane

    // Wrong-lane attack: stamp the SAME math as v1 → must not verify.
    const mislabeled = {
      ...(round as Record<string, unknown>),
      mappedOutcome: {
        crashPoint,
        pf: {
          algorithm: 'crash-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          roundId,
          rawPoint: raw,
        },
      },
    } as never;
    const bad = await verifyRoundRecord(mislabeled);
    expect(bad.valid).toBe(false);
  });

  it('replays the crash round with its stored difficulty gate', async () => {
    // 2026-08-21: the operator difficulty sizes the takeoff-blast gate; the
    // round's snapshot carries the level so the verifier replays the SAME
    // gate. Here an EASY round survives (gate leaks this hash) while HARD
    // busts it — a mislabeled level must NOT reproduce the stored raw point.
    // (roundId chosen by probing the fixed gates against this seed.)
    const serverSeed = 'e'.repeat(64);
    const roundId = 'round-easy-4';
    const distribution = { '1.00-2.00': 50, '2.00-10.00': 50 };
    const easyGate = crashGateForLevel('easy');
    const raw = generateCrashPointRaw(serverSeed, roundId, 0.04, easyGate);
    const hardGate = crashGateForLevel('hard');
    const wrongRaw = generateCrashPointRaw(serverSeed, roundId, 0.04, hardGate);
    expect(raw).toBeGreaterThan(1);
    expect(wrongRaw).toBe(1);
    const crashPoint = Math.max(1, remapCrashPoint(raw, distribution));
    const round = {
      ...base,
      gameSlug: 'aviator',
      clientSeed: `crash:${roundId}`,
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'BUST',
      configSnapshot: {
        configJson: { crash_distribution: distribution },
        difficulty: 'easy',
      },
      mappedOutcome: {
        crashPoint,
        pf: {
          algorithm: 'crash-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          roundId,
          rawPoint: raw,
          difficulty: 'easy',
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const result = await verifyRoundRecord(round);
    expect(result.rawMatches).toBe(true);
    expect(result.valid).toBe(true);
    // Same record, mislabelled level -> raw no longer reproduces -> verifier
    // catches the mislabeled gate.
    const mislabeled = {
      ...(round as object),
      configSnapshot: {
        configJson: { crash_distribution: distribution },
        difficulty: 'hard',
      },
    } as never;
    const bad = await verifyRoundRecord(mislabeled);
    expect(bad.rawMatches).toBe(false);
    expect(bad.valid).toBe(false);
  });

  it('replays a complete session transcript', async () => {
    const serverSeed = 'c'.repeat(64);
    const clientSeed = 'client';
    const raw = PROVABLY_FAIR.generateRawOutcome(serverSeed, clientSeed, 0);
    const config = {
      slug: 'mines',
      maxWinMultiplier: 10_000,
      minBet: 10,
      configJson: { grid_size: 25 },
    } as never;
    const choices = { mineCount: 3 };
    const init = minesSession.init(raw, choices, config, 'NONE');
    const mines = (init.extra as { mines: number[] }).mines;
    const tile = Array.from({ length: 25 }, (_, index) => index).find(
      (index) => !mines.includes(index)
    )!;
    const initial = {
      roundId: 'session-round',
      slug: 'mines',
      betAmount: '10',
      clientSeed,
      nonce: 0,
      rawOutcome: raw,
      status: 'ACTIVE',
      stepIndex: 0,
      currentMultiplier: init.currentMultiplier,
      nextMultiplier: init.nextMultiplier,
      steps: [],
      extra: init.extra,
      configSnapshot: config,
      forceMode: 'NONE',
      demo: false,
      createdAt: Date.now(),
      deductedFrom: [{ type: 'REAL', amount: '10' }],
    } as SessionState;
    const step = minesSession.step(initial, { tile }, config)!;
    const multiplier = step.next.currentMultiplier;
    const saved = {
      ...initial,
      status: 'CASHOUT',
      stepIndex: 1,
      currentMultiplier: multiplier,
      nextMultiplier: step.next.nextMultiplier,
      extra: step.next.extra,
      steps: [
        step.stepResult,
        { cashout: true, currentMultiplier: multiplier, final: true },
      ],
    };
    const round = {
      ...base,
      gameSlug: 'mines',
      clientSeed,
      nonce: 0,
      choices,
      rawOutcome: new Decimal(raw),
      result: 'CASHOUT',
      payoutMultiplier: new Decimal(multiplier),
      payoutAmount: new Decimal(10).mul(multiplier).toDecimalPlaces(2),
      configSnapshot: config,
      mappedOutcome: { session: saved },
      seedPair: seedPair(serverSeed),
    } as never;
    const result = await verifyRoundRecord(round);
    expect(result).toMatchObject({
      valid: true,
      mappedMatches: true,
      payoutMatches: true,
    });
  });
});
// H-03: a mutually-altered (multiplier, payout) pair must NOT pass anymore.
describe('H-03 — payout/result integrity lanes', () => {
  it('catches a WinGo round whose multiplier/payout were raised in tandem', async () => {
    const serverSeed = 'b'.repeat(64);
    const raw = PROVABLY_FAIR.generateRawOutcome(serverSeed, 'wingo', 0);
    const weights = Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }));
    const number = drawNumber(raw, weights);
    const choice = colorOf(number);
    const round = {
      ...base,
      gameSlug: 'wingo',
      clientSeed: 'wingo',
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'WIN',
      choices: { choice },
      // attacker raised BOTH: arithmetic (10×9 = 90) stays self-consistent…
      payoutMultiplier: new Decimal(9),
      payoutAmount: new Decimal(90),
      configSnapshot: {
        configJson: {
          number_weights: weights,
          payouts: {
            red: 1.96,
            green: 1.96,
            violet: 1.96,
            number: 1.96,
            big: 1.96,
            small: 1.96,
          },
        },
      },
      configSnapshotHash: null,
      mappedOutcome: {
        number,
        multiplier: 9,
        pf: {
          algorithm: 'wingo-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          clientSeed: 'wingo',
          nonce: 0,
          rawOutcome: raw,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const res = await verifyRoundRecord(round);
    expect(res.hashMatches).toBe(true);
    expect(res.rawMatches).toBe(true);
    expect(res.mappedMatches).toBe(true);
    expect(res.payoutMatches).toBe(true); // arithmetic alone is fooled…
    expect(res.resultMatches).toBe(false); // …the snapshot table is not
    expect(res.resultDetail).toContain('1.96');
    expect(res.valid).toBe(false);
  });

  it('catches a WinGo round whose stored choice+result contradict the verified number', async () => {
    const serverSeed = 'c'.repeat(64);
    const raw = PROVABLY_FAIR.generateRawOutcome(serverSeed, 'wingo', 0);
    const weights = Array.from({ length: 10 }, (_, number) => ({ number, weight: 10 }));
    const number = drawNumber(raw, weights);
    // pick a choice the verified number does NOT satisfy
    const losingChoice = colorOf(number) === 'red' ? 'green' : 'red';
    const round = {
      ...base,
      gameSlug: 'wingo',
      clientSeed: 'wingo',
      nonce: 0,
      rawOutcome: new Decimal(raw),
      result: 'WIN', // falsified: a losing choice recorded as a win
      choices: { choice: losingChoice },
      payoutMultiplier: new Decimal(1.96),
      payoutAmount: new Decimal(19.6),
      configSnapshot: {
        configJson: {
          number_weights: weights,
          payouts: {
            red: 1.96,
            green: 1.96,
            violet: 1.96,
            number: 1.96,
            big: 1.96,
            small: 1.96,
          },
        },
      },
      configSnapshotHash: null,
      mappedOutcome: {
        number,
        multiplier: 1.96,
        pf: {
          algorithm: 'wingo-hmac-v1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          clientSeed: 'wingo',
          nonce: 0,
          rawOutcome: raw,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    const res = await verifyRoundRecord(round);
    expect(res.resultMatches).toBe(false);
    expect(res.valid).toBe(false);
  });

  it('crash: a stored cashout multiple above what the verified crash point can finance fails', async () => {
    const serverSeed = 'd'.repeat(64);
    // crash-hmac-v1: pre-flight join (join=1); verified crash ≈5.10×; stored 8×.
    const rawPoint = generateCrashPointRaw(serverSeed, 'r1', 0.04);
    const round = {
      ...base,
      gameSlug: 'aviator',
      clientSeed: 'crash:r1',
      nonce: 0,
      rawOutcome: new Decimal(rawPoint),
      result: 'CASHOUT',
      choices: {},
      payoutMultiplier: new Decimal(8),
      payoutAmount: new Decimal(80),
      configSnapshot: {
        configJson: { crash_distribution: { '1.00-2.00': 70, '2.00-10.00': 30 } },
      },
      configSnapshotHash: null,
      mappedOutcome: {
        roundId: 'r1',
        crashPoint: 5.102741329636715,
        joinMultiplier: 1,
        multiplier: 8,
        payout: 80,
        pf: {
          algorithm: 'crash-hmac-v1',
          roundId: 'r1',
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          rawPoint,
        },
      },
      seedPair: seedPair(serverSeed),
    } as never;
    // Mapped lane will also flag (computed crash ≠ 2.0 unless rawPoint matches),
    // but the RESULT lane must flag on its own logic: 5× > 2.0× possible.
    const res = await verifyRoundRecord(round);
    expect(res.resultMatches).toBe(false);
    expect(res.valid).toBe(false);
  });
});
