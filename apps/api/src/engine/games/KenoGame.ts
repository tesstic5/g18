// apps/api/src/engine/games/KenoGame.ts — 40-grid, 20 draws, payout tables (v3 GAME 11 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { mulberry32 } from './MinesGame';
import type { GameConfig } from '../../../src/generated/prisma/client';

/** Exact hypergeometric P(k matches): K draws of N, player holds n. */
function hypergeomProb(N: number, K: number, n: number, k: number): number {
  if (k > K || k > n || n - k > N - K) return 0;
  // log C(a,b) kept in logs to stay in double range
  const logC = (a: number, b: number): number => {
    if (b < 0 || b > a) return -Infinity;
    let s = 0;
    for (let i = 1; i <= b; i++) s += Math.log((a - b + i) / i);
    return s;
  };
  return Math.exp(logC(K, k) + logC(N - K, n - k) - logC(N, n));
}

/** M-02: reject — never narrow — a card the player did not pick as-is. */
function assertKenoPicks(
  rawPicks: number[],
  gridSize: number,
  maxPicks: number
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const p of rawPicks) {
    if (!Number.isInteger(p) || p < 1 || p > gridSize)
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        422,
        `Keno pick ${String(p)} is outside the live 1..${gridSize} grid`
      );
    if (seen.has(p))
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        422,
        'Keno picks must be distinct'
      );
    seen.add(p);
    out.push(p);
  }
  if (out.length > maxPicks)
    throw new AppError(
      ERROR_CODES.GAME_INVALID_CHOICES,
      422,
      `Too many keno picks (${out.length}); the live table allows ${maxPicks}`
    );
  return out;
}

export class KenoGame extends BaseGame {
  readonly slug = 'keno';

  override fairWinChance(choices: Record<string, unknown>, config: GameConfig): number {
    const cfg = config.configJson as {
      grid_size?: number;
      draw_count?: number;
      max_picks?: number;
      payout_tables?: Record<string, Record<string, number>>;
    };
    const gridSize = cfg.grid_size ?? 40;
    const drawCount = Math.min(gridSize, cfg.draw_count ?? 20);
    const maxPicks = cfg.max_picks ?? 10;
    const rawPicks = (choices as { picks?: number[] }).picks ?? [];
    const n = assertKenoPicks(rawPicks, gridSize, maxPicks).length;
    if (n === 0) return 0;
    const table = cfg.payout_tables?.[`${n}_picks`] ?? {};
    // "Win" in the engine's sense = pays back MORE than the stake, so only
    // multipliers strictly above 1 count (1x is a push, <1 consolation a loss).
    let p = 0;
    for (const [kStr, mult] of Object.entries(table)) {
      const k = Number(kStr);
      if (Number.isInteger(k) && Number(mult) > 1)
        p += hypergeomProb(gridSize, drawCount, n, k);
    }
    return Math.min(1, p);
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      grid_size?: number;
      draw_count?: number;
      max_picks?: number;
      payout_tables?: Record<string, Record<string, number>>;
    };
    const gridSize = cfg.grid_size ?? 40;
    const drawCount = Math.min(gridSize, cfg.draw_count ?? 20);
    // C-2: de-duplicate and range-check the picks BEFORE they are counted.
    // Matches used to be `picks.filter(p => drawn.has(p)).length`, so ten copies
    // of the same number scored "10 matches" whenever that single ball dropped
    // — roughly half of all rounds — paying the 250x jackpot. Measured RTP was
    // 12502%. The route-level schema rejects duplicates as well; this is the
    // independent guard so no future caller can reintroduce it.
    const maxPicks = cfg.max_picks ?? 10;
    const rawPicks = (choices as { picks?: number[] }).picks ?? [];
    // M-02: the C-2 collapse silently converted a dupe-laden 10-pick card into
    // a 1-pick bet — a DIFFERENT card with a different paytable. That is the
    // "silently changed selection" class: reject it. The live config's grid /
    // max_picks are enforced here (the static schema only pins the 40/10
    // platform default), so a config shrink instantly closes the bigger range.
    const picks = assertKenoPicks(rawPicks, gridSize, maxPicks);
    if (picks.length === 0)
      return {
        result: 'LOSE',
        payoutMultiplier: 0,
        mappedOutcome: { picks, drawn: [], matches: 0, payoutTable: {} },
      };

    // deterministic draw
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const drawn = new Set<number>();
    while (drawn.size < drawCount) drawn.add(Math.floor(rng() * gridSize) + 1);

    const matches = picks.filter((p) => drawn.has(p)).length;
    // D-089: config keys are plural (`2_picks`, `5_picks`) — was `_pick`,
    // so 2+ picks found no table → always lost (0% RTP).
    const table = cfg.payout_tables?.[`${picks.length}_picks`] ?? {};
    const multiplier = Number(table[String(matches)] ?? 0);
    // A round is a WIN only when the player gets back MORE than the stake.
    // Several Keno tables pay consolation amounts below 1× (e.g. 5 picks / 3
    // matches = 0.09×). Those used to be reported as `WIN` because the test was
    // `multiplier > 0`, so the player saw a green "YOU WIN" banner while their
    // ₨10 stake came back as ₨0.90 — a 91% loss labelled as a win.
    const won = multiplier >= 1;
    const partialRefund = multiplier > 0 && multiplier < 1;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      // `multiplier` is the amount actually paid (never blanked to 0) so the UI
      // can show "0.09× returned" instead of pretending nothing came back.
      mappedOutcome: {
        picks,
        drawn: [...drawn],
        matches,
        multiplier,
        win: won,
        partialRefund,
        payoutTable: table,
      },
    };
  }
}
