// packages/shared/src/validators/game-choices.ts
//
// WHY THIS FILE EXISTS
// --------------------
// `betRequestSchema.choices` used to be `z.record(z.string(), z.unknown())` —
// an arbitrary JSON blob, accepted from the client and fed straight into the
// game maths. Two exploits came directly out of that single line, both
// reproduced against the real handlers:
//
//   ROULETTE  a "split" pays 18x and the win test is `numbers.includes(pocket)`
//             with no length or geometry check. Sending
//             { type:'split', numbers:[0,1,2,...,36] } covers every pocket, so
//             it wins EVERY spin.                      measured RTP 1800%
//
//   KENO      matches are counted as `picks.filter(p => drawn.has(p)).length`,
//             so duplicates each count separately. Sending ten copies of the
//             same number scores "10 matches" whenever that one ball drops —
//             about half of all rounds — and pays the 250x jackpot.
//                                                      measured RTP 12502%
//
// Patching those two handlers would not have been enough: the same hole exists
// for any future game that trusts a client-supplied array. So the fix is
// structural — every game declares the exact shape of its own choices, and the
// route rejects anything else before a wallet is ever touched.
//
// This is defence in depth, not the only defence: the handlers ALSO validate
// independently (a bug here must not become money). Belt and braces on a money
// path is the right trade.
import { z } from 'zod';
import { luckyMaxZoneSize, LUCKY_DEFAULT_SPAN } from '../constants/lucky-number';

/** 0-36, integer. */
const pocket = z.number().int().min(0).max(36);

/**
 * Roulette.
 *
 * Every multi-pocket bet type is constrained to the EXACT number of pockets it
 * pays for, and the pockets must be distinct. `split` pays 18x because it
 * covers 2 of 37 pockets — allowing any other length is simply handing money
 * away. Geometry (are these pockets actually adjacent on the felt?) is checked
 * in the handler, where the table layout lives.
 */
const rouletteBet = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('straight'), number: pocket }),
    z.object({ type: z.literal('split'), numbers: z.array(pocket).length(2) }),
    z.object({ type: z.literal('street'), numbers: z.array(pocket).length(3) }),
    z.object({ type: z.literal('corner'), numbers: z.array(pocket).length(4) }),
    z.object({ type: z.literal('six_line'), numbers: z.array(pocket).length(6) }),
    z.object({ type: z.literal('column'), column: z.number().int().min(1).max(3) }),
    z.object({ type: z.literal('dozen'), dozen: z.number().int().min(1).max(3) }),
    z.object({ type: z.literal('dozen-1') }),
    z.object({ type: z.literal('dozen-2') }),
    z.object({ type: z.literal('dozen-3') }),
    z.object({ type: z.literal('red') }),
    z.object({ type: z.literal('black') }),
    z.object({ type: z.literal('odd') }),
    z.object({ type: z.literal('even') }),
    z.object({ type: z.literal('low') }),
    z.object({ type: z.literal('high') }),
  ])
  .refine((b) => !('numbers' in b) || new Set(b.numbers).size === b.numbers.length, {
    message: 'Duplicate pockets in bet',
  });

/** Distinct integers in [min,max], at most `max` of them. */
const distinctInts = (min: number, max: number, maxLen: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1)
    .max(maxLen)
    .refine((a) => new Set(a).size === a.length, {
      message: 'Duplicate picks are not allowed',
    });

const LUCKY_MAX_ZONE = luckyMaxZoneSize(LUCKY_DEFAULT_SPAN);
export const GAME_CHOICE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // ── the two that were exploitable ───────────────────────────────────────
  roulette: z.object({ bet: rouletteBet }),
  // grid_size 40, max_picks 10 (apps/api/prisma/seed.ts). Duplicates rejected.
  keno: z.object({ picks: distinctInts(1, 40, 10) }),

  // ── everything else, pinned to what each handler actually reads ─────────
  // The handler destructures `{ over, target }` and the board sends exactly
  // that. An earlier version of this schema only allowed `direction`, so `over`
  // was STRIPPED and every bet silently resolved as "under" — the opposite of
  // what the player picked, which is why wins showed as losses.
  // M-02: `over` is REQUIRED — a `direction`-only request used to be coerced
  // into `under` (the opposite of the player's pick for `over`). And target
  // 0/100 are rejected: target 0 ("under 0") is zero-probability (infinite
  // price), target 100 ("under 100") always wins at 0.99x — a guaranteed-loss
  // bet priced below 1x. Both are degenerate and must not be accepted.
  dice: z.object({
    target: z.number().gt(0).lt(100),
    over: z.boolean(),
  }),
  limbo: z.object({ target: z.number().min(1.01).max(1_000_000) }),
  'coin-flip': z.object({ choice: z.enum(['heads', 'tails']) }),
  wheel: z.object({ tier: z.string().min(1).max(32) }),
  'ring-of-fortune': z.object({ tier: z.string().min(1).max(32) }),
  // Lucky Number is a ZONE bet: the board sends the inclusive range the player
  // dragged. The old schema allowed `number`/`zone`, which the game never
  // reads, so both were stripped and every bet fell back to the full 1-100
  // range — i.e. it won 100% of the time (measured).
  // The exact-hit payout is FLOORED at 1.01x so that hitting your number
  // always counts as a win. Once a zone is wide enough that the derived payout
  // (span / zone width) falls below that floor, the floor takes over — and
  // past a certain width it pays MORE than the win probability can support:
  // a 100-wide zone covers every number, so it wins every round and returns
  // 101.00% with zero variance (measured live). Refuse those zones at the door
  // rather than paying them. The cap is DERIVED from the payout maths, so it
  // tracks any future change to the ladder, the floor or the target RTP.
  'lucky-number': z
    .object({
      betMin: z.number().int().min(1).max(100),
      betMax: z.number().int().min(1).max(100),
    })
    .refine((v) => v.betMin <= v.betMax, {
      message: 'Zone start must not be after zone end',
    })
    .refine((v) => v.betMax - v.betMin + 1 <= LUCKY_MAX_ZONE, {
      message: `Zone is too wide — cover at most ${LUCKY_MAX_ZONE} numbers`,
    }),
  // M-02: cup count is live-config (not always 3) — the schema only pins the
  // absolute safety bound; the handler rejects picks the live config can't
  // hold instead of silently clamping them onto cup 0.
  thimbles: z.object({ cup: z.number().int().min(0).max(16) }),
  // M-02: only 8/12/16 have RTP-checked paytables. 9-11/13-15 used to be
  // silently replayed on the 12-row board — a board the player never picked.
  plinko: z.object({
    risk: z.enum(['low', 'medium', 'high']).optional(),
    rows: z.union([z.literal(8), z.literal(12), z.literal(16)]).optional(),
    balls: z.number().int().min(1).max(16).optional(),
  }),
  baccarat: z.object({ bet: z.enum(['player', 'banker', 'tie']) }),
  'dragon-tiger': z.object({ bet: z.enum(['dragon', 'tiger', 'tie']) }),
  // The board sends `card` (which card art was chosen); `theme` was never a
  // real field, so the selection was being discarded.
  'scratch-card': z.object({
    card: z.union([z.number().int().min(0).max(20), z.string().max(32)]).optional(),
  }),
  mines: z.object({
    mineCount: z.number().int().min(1).max(24).optional(),
    tile: z.number().int().min(0).max(24).optional(),
  }),
  tower: z.object({
    difficulty: z.enum(['easy', 'medium', 'hard', 'expert']).optional(),
    column: z.number().int().min(0).max(3).optional(),
  }),
  stairs: z.object({
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    column: z.number().int().min(0).max(3).optional(),
  }),
  'hi-lo': z.object({
    guess: z.enum(['higher', 'lower']).optional(),
    currentRank: z.string().max(3).optional(),
  }),
  wingo: z.object({
    choice: z
      .union([
        z.number().int().min(0).max(9),
        z.enum(['green', 'red', 'violet', 'big', 'small']),
      ])
      .optional(),
    durationSec: z.number().int().optional(),
    roundId: z.string().max(64).optional(),
    multiplier: z.number().optional(),
  }),
  // Crash games carry no per-bet choices; the round is shared.
  aviator: z.object({ target: z.number().min(1).max(1_000_000).optional() }),
  'crash-x': z.object({ target: z.number().min(1).max(1_000_000).optional() }),
};

/**
 * Validate a bet's `choices` for one game.
 *
 * Unknown keys are stripped rather than rejected, so a future client that sends
 * an extra hint field cannot break live betting — but nothing unrecognised ever
 * reaches the maths. A game with no schema registered is rejected outright:
 * failing closed is the only safe default on a money path.
 */
export function validateGameChoices(
  slug: string,
  choices: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const schema = GAME_CHOICE_SCHEMAS[slug];
  if (!schema) return { ok: false, message: `Betting is not available for "${slug}"` };
  const parsed = schema.safeParse(choices ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return {
      ok: false,
      message: `Invalid bet — ${where}${first?.message ?? 'bad selection'}`,
    };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}
