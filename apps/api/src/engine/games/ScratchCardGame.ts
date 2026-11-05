// apps/api/src/engine/games/ScratchCardGame.ts — 3×3 grid, 3-in-a-row wins (v3 GAME 19 + v8)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';
import type { GameConfig } from '../../../src/generated/prisma/client';

interface SymbolDef {
  symbol: string;
  weight: number;
}

export class ScratchCardGame extends BaseGame {
  readonly slug = 'scratch-card';

  /** P(any row completes a paying combo) — EXACT: rows are independent draws,
   *  a row completes symbol s with (p_s)^3 and the events across rows are
   *  independent, so P(win) = 1 - (1 - Σp_s³)^rows. */
  override fairWinChance(
    _choices: Record<string, unknown>,
    config: GameConfig
  ): number {
    const cfg = config.configJson as {
      grid?: { rows: number; cols: number };
      symbols?: { symbol: string; weight: number }[];
      win_combos?: Array<{ symbol: string; count: number; multiplier: number }>;
    };
    const rows = cfg.grid?.rows ?? 3;
    const symbols = cfg.symbols ?? [
      { symbol: '💰', weight: 30 },
      { symbol: '💎', weight: 25 },
      { symbol: '🎰', weight: 20 },
      { symbol: '🎲', weight: 15 },
      { symbol: '⭐', weight: 7 },
      { symbol: '🍀', weight: 3 },
    ];
    const combos = cfg.win_combos ?? [
      { symbol: '💰', count: 3, multiplier: 9.04 },
      { symbol: '💎', count: 3, multiplier: 4.52 },
      { symbol: '🎰', count: 3, multiplier: 2.71 },
    ];
    const totalW = symbols.reduce((t, x) => t + x.weight, 0);
    if (totalW <= 0 || rows <= 0) return 0;
    const paying = new Set(
      combos.filter((c) => c.multiplier > 1 && c.count > 0).map((c) => c.symbol)
    );
    let pRow = 0;
    for (const x of symbols) {
      if (paying.has(x.symbol)) {
        const c = combos.find((z) => z.symbol === x.symbol)!;
        pRow += Math.pow(x.weight / totalW, c.count);
      }
    }
    return 1 - Math.pow(1 - pRow, rows);
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as {
      grid?: { rows: number; cols: number };
      symbols?: SymbolDef[];
      win_combos?: Array<{ symbol: string; count: number; multiplier: number }>;
    };
    const rows = cfg.grid?.rows ?? 3,
      cols = cfg.grid?.cols ?? 3;
    const symbols = cfg.symbols ?? [
      { symbol: '💰', weight: 30 },
      { symbol: '💎', weight: 25 },
      { symbol: '🎰', weight: 20 },
      { symbol: '🎲', weight: 15 },
      { symbol: '⭐', weight: 7 },
      { symbol: '🍀', weight: 3 },
    ];
    // M-2: the FALLBACK table (used whenever configJson is empty or partial) paid
    // 106.69% RTP — the house lost money on every round. Measured over 400,000
    // rounds against this exact handler. Recalibrated by scaling the three
    // multipliers by 0.9039, which lands at 96.47%; re-verified by simulation.
    const combos = cfg.win_combos ?? [
      { symbol: '💰', count: 3, multiplier: 9.04 },
      { symbol: '💎', count: 3, multiplier: 4.52 },
      { symbol: '🎰', count: 3, multiplier: 2.71 },
    ];

    // deterministic grid
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const totalW = symbols.reduce((s, x) => s + x.weight, 0);
    const grid: string[] = [];
    for (let i = 0; i < rows * cols; i++) {
      let r = rng() * totalW,
        idx = 0;
      for (let j = 0; j < symbols.length; j++) {
        r -= symbols[j]!.weight;
        if (r <= 0) {
          idx = j;
          break;
        }
      }
      grid.push(symbols[idx]!.symbol);
    }

    // win lines: rows only (win_rule 3_in_a_row — docs/13)
    const lines: string[][] = [];
    for (let r = 0; r < rows; r++) lines.push(grid.slice(r * cols, r * cols + cols));

    let multiplier = 0,
      winLine: string[] | null = null;
    for (const line of lines) {
      if (line.every((s) => s === line[0])) {
        const combo = combos.find((c) => c.symbol === line[0]);
        if (combo && combo.multiplier > multiplier) {
          multiplier = combo.multiplier;
          winLine = line;
        }
      }
    }
    const won = multiplier > 0;
    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        grid,
        rows,
        cols,
        winLine,
        win: won,
        multiplier: won ? multiplier : 0,
      },
    };
  }
}
