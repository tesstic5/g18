// apps/api/src/services/stakeLimits.ts
//
// H-1: minBet was enforced NOWHERE.
//
// Every game carries a `minBet` in the database. It is seeded per game, it is
// returned by GET /games and GET /games/:slug, and the web UI renders it. It
// was never once compared against the stake actually being wagered. The only
// floor anywhere on the bet path was zod's `.positive()`, so a R0.01 bet was
// perfectly legal — which matters because several bonuses (streak rewards,
// rakeback) pay flat amounts per qualifying round, making dust bets farmable.
//
// This module is the single place stake limits are decided, so no future route
// can forget to call it:
//
//   minBet            per game, from the DB
//   game_max_bet      per game, optional override in configJson
//   global_max_bet    platform-wide ceiling (admin setting)
//
// Also exposes the per-round LIABILITY cap. `maxWinMultiplier` bounds the
// multiplier but not the money: a large enough stake on a high-multiplier game
// has no ceiling in currency terms. maxPayoutFor() gives settlement code a hard
// number to clamp against.
import Decimal from 'decimal.js';
import { AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { getGameConfig } from './gameConfig';
import { getNumericSetting } from './settings';

const CURRENCY = process.env.CURRENCY_SYMBOL || '₨';
const fmt = (d: Decimal | number) =>
  `${CURRENCY}${new Decimal(d).toDecimalPlaces(2).toNumber().toLocaleString()}`;

/** Absolute fallback if no admin setting is present. */
const DEFAULT_GLOBAL_MIN_BET = 10;
const DEFAULT_GLOBAL_MAX_BET = 500_000;
/** Absolute fallback for a single round's payout, if nothing is configured. */
const DEFAULT_MAX_PAYOUT = 5_000_000;

/** Coerce a JSON-column value to a usable number, or return the fallback. */
function safeNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface StakeLimits {
  minBet: Decimal;
  maxBet: Decimal;
}

/** Resolve the effective stake window for a game. */
export async function stakeLimitsFor(slug: string): Promise<StakeLimits> {
  const config = await getGameConfig(slug);
  const cfgJson = (config.configJson ?? {}) as { max_bet?: number; min_bet?: number };

  // The platform floor wins over anything lower. A game may set a HIGHER
  // minimum of its own, but nothing may go under the admin's global figure —
  // otherwise the setting is advisory and dust bets creep back in.
  const globalMin = new Decimal(
    await getNumericSetting('global_min_bet', DEFAULT_GLOBAL_MIN_BET)
  );
  const gameMin = new Decimal(safeNumber(cfgJson.min_bet ?? config.minBet, 0));
  let minBet = Decimal.max(globalMin, gameMin);

  const globalMax = new Decimal(
    await getNumericSetting('global_max_bet', DEFAULT_GLOBAL_MAX_BET)
  );
  // A per-game ceiling always wins if it is tighter than the global one, so a
  // whale cannot put the platform maximum on the single highest-variance game.
  // A 0 or junk value in configJson is IGNORED rather than obeyed — obeying it
  // sets the maximum to 0 and blocks every bet on that game.
  const rawGameMax = safeNumber(cfgJson.max_bet, 0);
  const gameMax = rawGameMax > 0 ? new Decimal(rawGameMax) : null;
  let maxBet = gameMax ? Decimal.min(gameMax, globalMax) : globalMax;

  // Final sanity net. Whatever the database says, the platform must never end
  // up in a state where NOTHING can be bet — that is a total outage dressed up
  // as a validation message ("Maximum bet for this game is Rs0"). If the
  // resolved window is nonsense, fall back to the built-in defaults.
  if (!maxBet.isFinite() || maxBet.lte(0)) maxBet = new Decimal(DEFAULT_GLOBAL_MAX_BET);
  if (!minBet.isFinite() || minBet.lt(0)) minBet = new Decimal(DEFAULT_GLOBAL_MIN_BET);
  if (minBet.gt(maxBet)) {
    // A min above the max is also unplayable. Trust the max and pull the floor
    // down to it rather than rejecting everything.
    minBet = Decimal.min(minBet, maxBet);
  }

  return { minBet, maxBet };
}

/**
 * Throw unless `amount` is inside the game's stake window.
 *
 * Demo rounds are checked too: demo is a rehearsal for the real thing, and
 * letting demo accept stakes the real game rejects only teaches players a flow
 * that will fail later.
 */
export async function assertStakeWithinLimits(
  slug: string,
  amount: number,
  _demo = false
): Promise<void> {
  const { minBet, maxBet } = await stakeLimitsFor(slug);
  const stake = new Decimal(amount);

  if (stake.lt(minBet)) {
    throw new AppError(
      ERROR_CODES.GAME_STAKE_OUT_OF_RANGE,
      400,
      `Minimum bet for this game is ${fmt(minBet)}`
    );
  }
  if (stake.gt(maxBet)) {
    throw new AppError(
      ERROR_CODES.GAME_STAKE_OUT_OF_RANGE,
      400,
      `Maximum bet for this game is ${fmt(maxBet)}`
    );
  }
}

/**
 * The most this round may pay out, in money.
 *
 * `maxWinMultiplier` caps the MULTIPLIER; this caps the actual liability. Both
 * are applied — whichever binds first.
 */
export async function maxPayoutFor(slug: string): Promise<Decimal> {
  const config = await getGameConfig(slug).catch(() => null);
  const cfgJson = (config?.configJson ?? {}) as { max_payout?: number };
  // Same rule as the stake window: a 0 or junk per-game cap is ignored, never
  // obeyed. Obeying it would silently pay every winner nothing.
  const gameCap = safeNumber(cfgJson.max_payout, 0);
  if (gameCap > 0) return new Decimal(gameCap);
  return new Decimal(await getNumericSetting('global_max_payout', DEFAULT_MAX_PAYOUT));
}
