// apps/api/src/engine/games/WheelGame.ts — money wheel the player actually BETS on.
//
// WHAT CHANGED AND WHY
// --------------------
// The wheel used to ignore `choices` entirely: you tapped PLAY, the wheel span,
// and it paid whatever segment it stopped on. There was no decision to make, so
// it was not a game — it was a slot pull with extra steps.
//
// Now the wheel is a real money wheel (Crazy-Time / Big-Six style): the rim is
// divided into slices of a few TIERS, and the player backs a tier. You win only
// if the wheel stops on a slice of the tier you backed.
//
// FAIRNESS: a tier covering a fraction p of the rim pays 0.96 / p, so EVERY tier
// returns the same ~96% RTP. Backing the rare jackpot tier is high-variance, not
// bad value — exactly like betting a single number vs red on roulette.
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { AppError } from '../../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import type { GameConfig } from '../../../src/generated/prisma/client';

export interface WheelTier {
  /** stable id the client sends back as `choices.tier` */
  id: string;
  label: string;
  color: string;
  /** how many slices of the rim this tier occupies */
  slices: number;
}

/**
 * Default rim layout — 24 slices.
 *   yellow 12/24 = 50%    -> 1.92x
 *   blue    8/24 = 33.3%  -> 2.88x
 *   green   3/24 = 12.5%  -> 7.68x
 *   purple  1/24 = 4.17%  -> 23.04x
 */
export function defaultTiers(): WheelTier[] {
  return [
    { id: 'yellow', label: '2×', color: '#f5c842', slices: 12 },
    { id: 'blue', label: '3×', color: '#4d9fff', slices: 8 },
    { id: 'green', label: '5×', color: '#00d97e', slices: 3 },
    { id: 'purple', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
  ];
}

/** Fair payout for a tier: 0.96 / P(tier). */
export function tierPayout(tier: WheelTier, totalSlices: number, rtp = 0.96): number {
  const p = tier.slices / totalSlices;
  return +(rtp / p).toFixed(2);
}

/**
 * Build the physical rim: slices interleaved so the same tier is not all bunched
 * on one side (a real wheel alternates, and it makes the spin readable).
 * Returns tier ids in rim order — the client renders exactly this.
 */
export function buildRim(tiers: WheelTier[]): string[] {
  const total = tiers.reduce((s, t) => s + t.slices, 0);
  const rim: string[] = new Array(total);
  // place rarest tiers first at evenly spread positions, then fill with the rest
  const ordered = [...tiers].sort((a, b) => a.slices - b.slices);
  const taken = new Set<number>();
  for (const t of ordered.slice(0, -1)) {
    const gap = total / t.slices;
    for (let i = 0; i < t.slices; i++) {
      let pos = Math.round(i * gap + gap / 2) % total;
      while (taken.has(pos)) pos = (pos + 1) % total;
      taken.add(pos);
      rim[pos] = t.id;
    }
  }
  const filler = ordered[ordered.length - 1]!;
  for (let i = 0; i < total; i++) if (!rim[i]) rim[i] = filler.id;
  return rim;
}

export class WheelGame extends BaseGame {
  readonly slug = 'wheel';

  override fairWinChance(choices: Record<string, unknown>, config: GameConfig): number {
    const cfg = config.configJson as { tiers?: WheelTier[] };
    const tiers =
      Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : defaultTiers();
    const total = tiers.reduce((t, x) => t + x.slices, 0);
    const picked = String((choices as { tier?: string }).tier ?? '');
    const backed = tiers.find((t) => t.id === picked);
    return backed && total > 0 ? backed.slices / total : 0;
  }

  resolve(params: ResolveParams): GameHandlerResult {
    // Difficulty/force rounds: the same rim mapping is sampled until the stop
    // matches the decided verdict — the needle ALWAYS rests where the ledger
    // says it rests.
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const cfg = config.configJson as { tiers?: WheelTier[] };
    const tiers =
      Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : defaultTiers();
    const rim = buildRim(tiers);
    const total = rim.length;

    // Where the wheel stops — uniform over the physical slices.
    const index = Math.min(total - 1, Math.floor(rawOutcome * total));
    const picked = String((choices as { tier?: string }).tier ?? '');
    const backed = tiers.find((t) => t.id === picked) ?? null;

    const landedId = rim[index]!;
    const landedTier = tiers.find((t) => t.id === landedId) ?? tiers[0]!;

    // M-02: an unknown tier must be REJECTED, not silently settled as a loss
    // (the old `noPick` branch returned LOSE with payout 0, and the engine had
    // no refund path for it — the stake was simply gone). Throwing here rolls
    // the accept-settle transaction back, so the player is never debited for a
    // selection the live config does not contain.
    if (!backed) {
      throw new AppError(
        ERROR_CODES.GAME_INVALID_CHOICES,
        422,
        `Unknown wheel tier: ${picked}`
      );
    }

    const won = landedId === backed.id;
    const payout = tierPayout(backed, total);
    const multiplier = won ? payout : 0;

    return {
      result: won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        rim,
        index,
        landedId,
        landedLabel: landedTier.label,
        landedColor: landedTier.color,
        tiers,
        tier: backed.id,
        tierLabel: backed.label,
        win: won,
        multiplier,
        payoutIfWin: payout,
      },
    };
  }
}
