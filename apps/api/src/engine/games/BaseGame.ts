// apps/api/src/engine/games/BaseGame.ts — abstract game contract (docs/21 deliverable #3)
//
// THE WIN/LOSE COHERENCE CONTRACT (operator difficulty + force overrides)
// -----------------------------------------------------------------------
// There are now TWO ways a round can be decided:
//
//   1. FAIR / COMMITTED (default): the game's natural mapping reads the
//      committed rawOutcome directly (dice roll = u*100, wheel index = u*24…).
//      Handlers implement this as `sampleOutcome()`. Nothing else changed.
//
//   2. DECIDED (force ON, or game difficulty ≠ normal): the engine has already
//      decided win/lose (force, or u < effectiveWinChance). The handler's
//      resolve() must then PRODUCE A DISPLAY-CONSISTENT OUTCOME for that
//      decision — a dice roll that actually beats the target, a wheel stop that
//      actually lands on the backed tier. Every oneshot handler implements
//      this by sampling its own fair mapping conditioned on the decision
//      (rejection sampling), so the outcome shown is a genuine draw of the
//      game's physics restricted to the decided event. Display and settlement
//      can never disagree: the mapped outcome IS the settled outcome.
//
// fairWinChance() gives the engine the game's fair probability of a profit
// (payout > stake) for the player's choices. It is used ONLY for the decision
// (difficulty scaling) — payouts always come from the mapping itself, so RTP
// bookkeeping stays intact and difficulty N≠N only shifts win FREQUENCY.
import {
  ForceOverride,
  GameConfig,
  RoundResult,
} from '../../../src/generated/prisma/client';
import type { DifficultyLevel } from '../difficulty';
import { mulberry32 } from './rng';

export interface ResolveParams {
  isWin: boolean;
  rawOutcome: number; // 0-1 provably fair float
  config: GameConfig;
  choices: Record<string, unknown>; // player's game-specific inputs
  forceMode: ForceOverride;
  /** Difficulty resolved for THIS bet (engine-provided, 'normal' default). */
  difficulty?: DifficultyLevel;
}

export interface GameHandlerResult {
  mappedOutcome: unknown; // animation_data — client animates exactly this (docs/02)
  payoutMultiplier: number;
  result: RoundResult; // WIN | LOSE | CASHOUT | BUST (canonical enum)
}

/**
 * Every game extends this. resolve() MUST be pure-ish (no DB writes — settlement
 * happens in OutcomeEngine) and MUST respect config + isWin/forceMode.
 */
export abstract class BaseGame {
  abstract readonly slug: string;

  abstract resolve(
    params: ResolveParams
  ): Promise<GameHandlerResult> | GameHandlerResult;

  /**
   * The game's fair probability that a round pays back MORE than the stake
   * (payoutMultiplier > 1) for these choices, under `sampleOutcome`'s natural
   * mapping. One-shot games implemented via resolveDecided() MUST override
   * this; session/shared games may leave the default (null = engine keeps the
   * legacy winRate decision and skips difficulty+force for them).
   */
  fairWinChance(_choices: Record<string, unknown>, _config: GameConfig): number | null {
    return null;
  }

  /** The game's natural fair mapping. Default: subclasses that predate the
   *  contract don't need it (their resolve() IS the mapping). */
  protected sampleOutcome(_params: ResolveParams): GameHandlerResult {
    throw new Error(`${this.slug}: sampleOutcome not implemented`);
  }

  /**
   * The DECIDED path. Returns `sampleOutcome` directly when nothing is asked
   * (force NONE + difficulty normal — bit-for-bit the legacy behavior, so
   * provably-fair reproduction and every RTP test keep holding), otherwise
   * rejection-samples `sampleOutcome` until the outcome matches the decision.
   *
   * The candidate stream is the same deterministic mulberry32 chain used by the
   * committed games (seeded from the round's rawOutcome), so every sampled
   * round remains 100% reproducible on the verify page.
   */
  protected resolveDecided(params: ResolveParams): GameHandlerResult {
    const difficulty = params.difficulty ?? 'normal';
    if (params.forceMode === 'NONE' && difficulty === 'normal') {
      return this.sampleOutcome(params);
    }
    const desiredWin =
      params.forceMode === 'FORCE_WIN'
        ? true
        : params.forceMode === 'FORCE_LOSE'
          ? false
          : params.isWin;
    return sampleConditioned(
      params.rawOutcome,
      (u) => this.sampleOutcome({ ...params, rawOutcome: u }),
      desiredWin
    );
  }

  protected clamp(multiplier: number, config: GameConfig): number {
    return Math.min(multiplier, Number(config.maxWinMultiplier));
  }
}

/**
 * Rejection-sample `sampler` until the produced outcome matches the desired
 * verdict. "win" = pays back more than the stake (payoutMultiplier > 1) — the
 * exact same rule the engine's final result normalisation uses, so a forced
 * round can never settle in a state the banner would contradict.
 *
 * Deterministic: candidates come from a mulberry32 chain seeded by the round's
 * committed rawOutcome. Falls back to the LAST candidate after MAX_TRIES (e.g.
 * a win forced on a bet whose win region is empty — impossible to satisfy).
 */
export function sampleConditioned(
  rawOutcome: number,
  sampler: (u: number) => GameHandlerResult,
  desiredWin: boolean,
  isWin: (r: GameHandlerResult) => boolean = (r) => r.payoutMultiplier > 1
): GameHandlerResult {
  const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff) >>> 0);
  const MAX_TRIES = 512;
  let last: GameHandlerResult | null = null;
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = sampler(rng());
    if (isWin(candidate) === desiredWin) return candidate;
    last = candidate;
  }
  return last!;
}

// ── Registry — every game registered once (docs/21 deliverable #3) ─────────
const registry = new Map<string, BaseGame>();
export function registerGame(game: BaseGame) {
  registry.set(game.slug, game);
}
export function getGameHandler(slug: string): BaseGame {
  const handler = registry.get(slug);
  if (!handler) throw new Error(`No game handler registered for ${slug}`);
  return handler;
}
export function registeredSlugs(): string[] {
  return [...registry.keys()];
}

// Lazy registration (avoids circular imports at module init).
// IMPORTANT: awaited — bets can arrive before the handlers finish importing.
let registered: Promise<void> | null = null;
export function ensureGamesRegistered(): Promise<void> {
  if (registered) return registered;
  // On failure the cached promise is CLEARED so a later bet can retry. Caching
  // a rejected promise permanently broke all betting until a restart.
  registered = (async () => {
    const games = [
      () => import('./DiceGame').then((m) => new m.DiceGame()),
      () => import('./AviatorGame').then((m) => new m.AviatorGame()),
      () => import('./AviatorGame').then((m) => new m.CrashXGame()),
      () => import('./PlinkoGame').then((m) => new m.PlinkoGame()),
      () => import('./WingoGame').then((m) => new m.WingoGame()),
      () => import('./MinesGame').then((m) => new m.MinesGame()),
      () => import('./WheelGame').then((m) => new m.WheelGame()),
      () => import('./CoinFlipGame').then((m) => new m.CoinFlipGame()),
      () => import('./TowerGame').then((m) => new m.TowerGame()),
      () => import('./StairsGame').then((m) => new m.StairsGame()),
      () => import('./HiLoGame').then((m) => new m.HiLoGame()),
      () => import('./LimboGame').then((m) => new m.LimboGame()),
      () => import('./KenoGame').then((m) => new m.KenoGame()),
      () => import('./DragonTigerGame').then((m) => new m.DragonTigerGame()),
      () => import('./RouletteGame').then((m) => new m.RouletteGame()),
      () => import('./BaccaratGame').then((m) => new m.BaccaratGame()),
      () => import('./ThimblesGame').then((m) => new m.ThimblesGame()),
      () => import('./RingOfFortuneGame').then((m) => new m.RingOfFortuneGame()),
      () => import('./ScratchCardGame').then((m) => new m.ScratchCardGame()),
      () => import('./LuckyNumberGame').then((m) => new m.LuckyNumberGame()),
    ];
    for (const load of games) {
      const g = await load();
      registerGame(g);
    }
  })().catch((e) => {
    registered = null;
    throw e;
  });
  return registered;
}
