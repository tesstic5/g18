// packages/shared/src/constants/lucky-number.ts
//
// Lucky Number payout maths — SHARED so the bet validator and the game engine
// can never disagree about what a zone is worth.
//
// WHY THIS LIVES IN SHARED
// ------------------------
// The exact-hit payout is derived (span / zone width, minus the consolation
// EV), and it has a FLOOR so that hitting your number always pays something.
// Once a zone gets wide enough that the derived payout falls below the floor,
// the floor takes over — and past a certain width the floor pays MORE than the
// win probability can support, so the round returns over 100% RTP. Keeping the
// formula in one place lets the validator refuse those zones at the door
// instead of discovering them in the ledger.
//
// The engine and this file use identical inputs, so the guard and the payout
// are guaranteed to agree.

/** Never pay less than this on an exact hit (so a hit is always a "win"). */
export const LUCKY_PAYOUT_FLOOR = 1.01;

/** RTP the payout ladder is built to return (the house keeps 4%). */
export const LUCKY_TARGET_RTP = 0.96;

/**
 * Expected consolation return per round, in units of "numbers": the near-miss
 * windows are delta 1-2 (2 numbers x 0.2), 3-5 (3 x 0.1) and 6-10 (5 x 0.05)
 * = 1.9 numbers' worth, shared across the whole span.
 */
export const LUCKY_CONSOLATION_NUMBERS = 1.9;

/** Default board. The bet schema pins 1..100 and the seeded config matches. */
export const LUCKY_DEFAULT_SPAN = 100;

/** Near-miss ladder: the payout for a miss `delta` numbers outside the zone. */
export function luckyConsolationPayout(delta: number): number {
  if (delta >= 1 && delta <= 2) return 0.2;
  if (delta >= 3 && delta <= 5) return 0.1;
  if (delta >= 6 && delta <= 10) return 0.05;
  return 0;
}

/** Expected consolation for the whole round, before dividing by the span. */
export function luckyExactPayout(span: number, zoneSize: number): number {
  const consolationEv = LUCKY_CONSOLATION_NUMBERS / span;
  const zone = Math.max(1, Math.min(span, zoneSize));
  const fair = ((LUCKY_TARGET_RTP - consolationEv) * span) / zone;
  return Number(Math.max(LUCKY_PAYOUT_FLOOR, fair).toFixed(2));
}

/**
 * Total consolation payout across the `outside` numbers the zone does NOT
 * cover, assuming the leftovers are split evenly on both sides of the zone.
 *
 * Splitting yields the HIGHEST consolation (both sides start at delta 1, the
 * best-paying miss). A zone hard against an edge concentrates the leftovers on
 * one side, pushing some of them out to cheaper deltas. Estimating high makes
 * `luckyMaxZoneSize` conservative — it will never wave through a zone that
 * actually returns over 100%.
 */
export function luckyConsolationTotal(outside: number): number {
  if (outside <= 0) return 0;
  const left = Math.ceil(outside / 2);
  const right = Math.floor(outside / 2);
  let total = 0;
  for (let d = 1; d <= left; d++) total += luckyConsolationPayout(d);
  for (let d = 1; d <= right; d++) total += luckyConsolationPayout(d);
  return total;
}

/**
 * Expected return (RTP as a fraction, 1.0 = break-even) for a zone of this
 * width, using the SAME numbers the engine will use to pay it.
 */
export function luckyZoneRtp(span: number, zoneSize: number): number {
  const zone = Math.max(1, Math.min(span, zoneSize));
  const hitEv = (zone / span) * luckyExactPayout(span, zone);
  const missEv = luckyConsolationTotal(span - zone) / span;
  return hitEv + missEv;
}

/**
 * Widest zone a player may back without the house ever paying out more than
 * it takes (RTP <= 1.0), for this board size.
 *
 * Derived, not hard-coded: if the ladder, the floor or the target RTP ever
 * change, this boundary moves with them. For the default 1-100 board it is 98
 * — zone 98 returns ~99.4%, zone 99 returns ~100.2% and zone 100 returns
 * exactly 101% on every single round.
 */
export function luckyMaxZoneSize(span: number): number {
  const board = Math.max(1, Math.floor(span));
  let allowed = 1;
  for (let z = 1; z <= board; z++) {
    if (luckyZoneRtp(board, z) <= 1) allowed = z;
  }
  return allowed;
}
