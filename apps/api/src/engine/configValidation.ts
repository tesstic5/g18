// apps/api/src/engine/configValidation.ts — C-06: per-game STRICT config
// validation + exact per-choice RTP bound checking.
//
// WHY THIS EXISTS
// ---------------
// The engine has always had the generic `validateConfig` invariant
// (winRate × mean(payout_weights) ≤ RTP ceiling). But game handlers never
// read `payout_weights` at all — they read `payouts`, `payout_tables`,
// `payout_ladder`, `risk_levels`, `tiers`, `number_weights`, crash ranges,
// symbol weights, grids and session ladders. An admin could therefore save a
// catistrophic config that generic validation happily "passed" while the
// game's own table paid 400% RTP — or a malformed loop-making config that
// hung the round machinery.
//
// THE CONTRACT
// ------------
// Every registered game has:
//   1. a STRICT key whitelist (unknown configJson keys are rejected — a typo
//      must never silently no-op), and
//   2. a validator that checks structure (non-empty tables, ordered ranges,
//      finite numbers in range) AND per-choice liability:
//        - every expressible payout multiplier ≤ maxWinMultiplier
//        - the game's actual RTP ≤ RTP ceiling (99%).
//
// RTP MATH — how each number is derived:
//   * Fair-derivation games (mines, hilo, wheel, ring, stairs, dice,
//     limbo): payouts come from 0.96…0.99 / true-odds INSIDE the handler, so
//     RTP is structural — we validate the structure and the cap.
//     Tower is hybrid: an admin per-floor ladder is a table (exact RTP per
//     cashout-at-k); missing ladders fall back to the fair 0.96/p^f formula.
//   * Table games (coinflip, thimbles, wingo, roulette, keno, dragon-tiger,
//     baccarat, plinko, scratch, lucky-number): we compute RTP from the
//     configured table and the game's true probabilities — exact closed form
//     for card/dice/lottery math, and deterministic Monte-Carlo (seeded RNG)
//     for scratch/scratch-like layouts where enumeration is unweildy.
//
// Callers: saveGameConfig (admin API), prisma/seed.ts (operators editing
// seeds), and the test-suite. This module is deliberately dependency-free so
// seed can import it without spinning up the API.
import { LIMITS } from '@casino/shared/constants/limits';
import {
  parseTowerLadder,
  fairTowerLadder,
  TOWER_FLOORS as SHARED_TOWER_FLOORS,
} from '@casino/shared';

export interface ConfigIssue {
  field: string;
  message: string;
}

export interface GameConfigCheck {
  ok: boolean;
  issues: ConfigIssue[];
  /**
   * Non-blocking advisories (v1.3.5·§5): the config SAVES, but the operator is
   * told a choice drifts far from its usual payback — e.g. WinGo weights that
   * quietly squeeze one bet's RTP from 96% down to a few percent.
   */
  warnings?: ConfigIssue[];
  /** per-choice effective RTP table in percent, when the game computes one */
  rtpTable?: Record<string, number>;
  /** highest RTP any legal choice can express, in percent */
  worstCaseRtp: number;
  /** highest payable multiplier any legal choice can express */
  maxPayout: number;
}

const CEILING = LIMITS.RTP_CEILING; // 99

// ── helpers ──────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function posNum(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** n choose k, exact integers for our ranges. */
function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k > n - k) k = n - k;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** Hypergeometric: P(exactly `hit` of `picks` picked land in `draws` drawn from `grid`). */
function hypergeometric(
  grid: number,
  picks: number,
  draws: number,
  hit: number
): number {
  return (comb(draws, hit) * comb(grid - draws, picks - hit)) / comb(grid, picks);
}

interface RegistryEntry {
  /** allowed configJson keys for this game (in addition to COMMON_KEYS) */
  keys: string[];
  validate(
    cj: Record<string, unknown>,
    maxWin: number
  ): {
    issues: ConfigIssue[];
    worstCaseRtp: number;
    maxPayout: number;
  };
}

/** Keys accepted on EVERY game config. */
const COMMON_KEYS = ['payout_weights', 'difficulty', 'max_bet', 'enabled_bet_types'];

function err(f: string, m: string): ConfigIssue {
  return { field: f, message: m };
}

function expectKeys(cj: Record<string, unknown>, allowed: string[]): ConfigIssue[] {
  const ok = new Set([...COMMON_KEYS, ...allowed]);
  return Object.keys(cj)
    .filter((k) => !ok.has(k))
    .map((k) => err(k, `unknown config key for this game (strict schema)`));
}

/** weighted-range crash distribution, shared by aviator/crash-x. */
function validateCrashDistribution(
  cj: Record<string, unknown>,
  maxWin: number
): { issues: ConfigIssue[]; worstCaseRtp: number; maxPayout: number } {
  const issues: ConfigIssue[] = [];
  const d = cj.crash_distribution;
  if (!isObj(d) || Object.keys(d).length === 0) {
    issues.push(err('crash_distribution', 'must be a non-empty weight map'));
    return { issues, worstCaseRtp: 0, maxPayout: 0 };
  }
  let total = 0;
  let maxPayout = 0;
  for (const [range, w] of Object.entries(d)) {
    const weight = num(w);
    if (weight === null || weight <= 0) {
      issues.push(err('crash_distribution', `weight of "${range}" must be > 0`));
      continue;
    }
    total += weight;
    // range forms: "a-b" or "a+"; bounds must parse and be ordered, start ≥ 1
    const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(\+)?$/.exec(range.trim());
    if (!m) {
      issues.push(err('crash_distribution', `unparseable range "${range}"`));
      continue;
    }
    const lo = parseFloat(m[1]!);
    const hi = m[3] ? Infinity : m[2] ? parseFloat(m[2]) : NaN;
    if (lo < 1)
      issues.push(err('crash_distribution', `range "${range}" starts below 1×`));
    if (m[2] && Number.isFinite(hi) && hi <= lo)
      issues.push(err('crash_distribution', `range "${range}" upper ≤ lower`));
    // C-04: the "+" tail pays up to crashTailUpper(lo, ∞) = max(lo+100, 3lo).
    const effectiveHi = Number.isFinite(hi) ? hi : Math.max(lo + 100, lo * 3);
    if (effectiveHi > maxPayout) maxPayout = effectiveHi;
  }
  if (total <= 0) issues.push(err('crash_distribution', 'weights must sum to > 0'));
  if (maxPayout > maxWin)
    issues.push(
      err(
        'crash_distribution',
        `tail bucket allows a ${maxPayout}× crash point above maxWinMultiplier ${maxWin}×`
      )
    );
  for (const k of ['round_interval_ms', 'tick_interval_ms', 'growth_rate'] as const) {
    if (cj[k] !== undefined && !(num(cj[k])! > 0))
      issues.push(err(k, 'must be a positive finite number'));
  }
  // Crash RTP: priced at takeoff ≈96%, mid-flight priced at 94% (crash-pricing.ts);
  // structurally ≈ the chosen distribution's shape — no table to over-shoot.
  return { issues, worstCaseRtp: 96.5, maxPayout };
}

/** wheel-style tier list ({ id, label, color?, slices }) — payouts derived 0.96/P. */
function validateWheelTiers(
  cj: Record<string, unknown>,
  maxWin: number,
  field = 'tiers'
): { issues: ConfigIssue[]; worstCaseRtp: number; maxPayout: number } {
  const issues: ConfigIssue[] = [];
  const tiers = cj[field];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    issues.push(err(field, 'must be a non-empty tier list'));
    return { issues, worstCaseRtp: 0, maxPayout: 0 };
  }
  let total = 0;
  const ids = new Set<string>();
  let maxPayout = 0;
  for (const t of tiers) {
    if (!isObj(t) || typeof t.id !== 'string' || t.id.length === 0) {
      issues.push(err(field, 'every tier needs a string id'));
      continue;
    }
    if (ids.has(t.id as string))
      issues.push(err(field, `duplicate tier id "${t.id as string}"`));
    ids.add(t.id as string);
    const slices = num(t.slices);
    if (slices === null || slices <= 0 || !Number.isInteger(slices))
      issues.push(err(field, `tier "${t.id as string}" slices must be a positive int`));
    else total += slices;
  }
  const totalSlices = Math.max(1, total);
  for (const t of tiers as Array<Record<string, unknown>>) {
    if (typeof t.slices !== 'number') continue;
    const payout = 0.96 / (t.slices / totalSlices);
    if (payout <= 1)
      issues.push(
        err(
          field,
          `tier "${t.id as string}" is guaranteed to lose (payout ${payout.toFixed(3)}× < 1)`
        )
      );
    if (payout > maxPayout) maxPayout = payout;
  }
  if (maxPayout > maxWin)
    issues.push(
      err(
        field,
        `tier payout up to ${maxPayout.toFixed(2)}× exceeds maxWinMultiplier ${maxWin}×`
      )
    );
  return { issues, worstCaseRtp: 96, maxPayout };
}

/** payout tables keyed "<n>_picks" → { hits: multiplier } (keno). */
function validateKeno(
  cj: Record<string, unknown>,
  maxWin: number
): { issues: ConfigIssue[]; worstCaseRtp: number; maxPayout: number } {
  const issues: ConfigIssue[] = [];
  const grid = posNum(cj.grid_size) ?? 40;
  const maxPicks = posNum(cj.max_picks) ?? 10;
  const draws = posNum(cj.draw_count) ?? 20;
  if (draws > grid) issues.push(err('draw_count', 'cannot draw more than the grid'));
  if (maxPicks > grid) issues.push(err('max_picks', 'cannot pick more than the grid'));
  const tables = cj.payout_tables;
  if (!isObj(tables) || Object.keys(tables).length === 0) {
    issues.push(err('payout_tables', 'must define at least one pick-count table'));
  } else {
    for (const [key, table] of Object.entries(tables)) {
      const m = /^(\d+)_picks$/.exec(key);
      if (!m) {
        issues.push(err('payout_tables', `key "${key}" must look like "3_picks"`));
        continue;
      }
      const picks = parseInt(m[1]!, 10);
      if (picks < 1 || picks > maxPicks)
        issues.push(err('payout_tables', `key "${key}" exceeds max_picks ${maxPicks}`));
      if (!isObj(table)) {
        issues.push(err('payout_tables', `table "${key}" must be an object`));
        continue;
      }
      // EXACT RTP for this pick count, hypergeometric closed form.
      let rtp = 0;
      let localMax = 0;
      for (let hit = 0; hit <= Math.min(picks, draws); hit++) {
        const mult = num(table[String(hit)]) ?? 0;
        if (mult < 0)
          issues.push(err('payout_tables', `negative multiplier in "${key}"`));
        if (mult > localMax) localMax = mult;
        rtp += hypergeometric(grid, picks, draws, hit) * mult;
      }
      if (localMax > maxWin)
        issues.push(
          err(
            'payout_tables',
            `"${key}" pays up to ${localMax}× > maxWinMultiplier ${maxWin}×`
          )
        );
      if (rtp * 100 > CEILING + 0.5)
        issues.push(
          err(
            'payout_tables',
            `"${key}" exact RTP ${(rtp * 100).toFixed(2)}% exceeds the ${CEILING}% ceiling`
          )
        );
    }
  }
  return { issues, worstCaseRtp: 0, maxPayout: 0 }; // worst-case per-table asserted inline above
}

const REGISTRY: Record<string, RegistryEntry> = {
  aviator: {
    keys: [
      'round_interval_ms',
      'tick_interval_ms',
      'base_speed',
      'growth_rate',
      'crash_distribution',
    ],
    validate: (cj, m) => ({
      ...validateCrashDistribution(cj, m),
      issues: expectKeys(cj, REGISTRY.aviator!.keys).concat(
        validateCrashDistribution(cj, m).issues
      ),
    }),
  },
  'crash-x': {
    keys: [
      'round_interval_ms',
      'tick_interval_ms',
      'base_speed',
      'growth_rate',
      'crash_distribution',
    ],
    validate: (cj, m) => ({
      ...validateCrashDistribution(cj, m),
      issues: expectKeys(cj, REGISTRY['crash-x']!.keys).concat(
        validateCrashDistribution(cj, m).issues
      ),
    }),
  },
  coinflip: {
    keys: ['options', 'payout', 'win_probability'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.coinflip!.keys);
      const payout = posNum(cj.payout);
      const p = posNum(cj.win_probability);
      if (!payout) issues.push(err('payout', 'required positive number'));
      if (!p || p >= 1) issues.push(err('win_probability', 'must be in (0, 1)'));
      const options = cj.options;
      if (!Array.isArray(options) || options.length < 2)
        issues.push(err('options', 'needs at least 2 options'));
      const rtp = payout && p ? payout * p * 100 : 0;
      if (rtp > CEILING)
        issues.push(
          err('payout', `RTP ${rtp.toFixed(2)}% exceeds the ${CEILING}% ceiling`)
        );
      if (payout && payout > maxWin)
        issues.push(
          err('payout', `payout ${payout}× exceeds maxWinMultiplier ${maxWin}×`)
        );
      return { issues, worstCaseRtp: rtp, maxPayout: payout ?? 0 };
    },
  },
  dice: {
    keys: ['min_target', 'max_target', 'segments'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.dice!.keys);
      const lo = posNum(cj.min_target);
      const hi = posNum(cj.max_target);
      if (!lo || !hi || hi <= lo || hi > 99)
        issues.push(err('max_target', 'need 0 < min_target < max_target ≤ 99'));
      // Dice RTP is structural: payout = 99 / P(win) — always 99% at every target.
      // Liability: the tightest band (1-success-step) pays up to 99×, itself
      // clamped by the handler at maxWinMultiplier.
      const maxPayout = Math.min(99, maxWin);
      return { issues, worstCaseRtp: 99, maxPayout };
    },
  },
  limbo: {
    keys: ['min_target', 'max_target', 'distribution_curve', 'rtp_adjustment_factor'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.limbo!.keys);
      const min = posNum(cj.min_target);
      const max = posNum(cj.max_target);
      if (!min || min < 1.000_001) issues.push(err('min_target', 'must be > 1'));
      if (!max || !min || max <= min)
        issues.push(err('max_target', 'must exceed min_target'));
      const f = posNum(cj.rtp_adjustment_factor);
      if (f !== null && f >= 1)
        issues.push(err('rtp_adjustment_factor', `RTP factor ${f} ≥ 1 pays ≥ 100%`));
      // Structural RTP = factor (99/p × p = 99%). Max payout = max target capped.
      const maxPayout = Math.min(max ?? 0, maxWin);
      if ((max ?? 0) > maxWin)
        issues.push(
          err('max_target', `target ${max}× exceeds maxWinMultiplier ${maxWin}× cap`)
        );
      return { issues, worstCaseRtp: (f ?? 0.99) * 100, maxPayout };
    },
  },
  keno: {
    keys: ['grid_size', 'max_picks', 'draw_count', 'draw_weights', 'payout_tables'],
    validate: (cj, maxWin) => {
      const r = validateKeno(cj, maxWin);
      return {
        ...r,
        issues: expectKeys(cj, REGISTRY.keno!.keys).concat(r.issues),
      };
    },
  },
  roulette: {
    keys: ['pockets', 'zero', 'wheel_layout', 'payouts'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.roulette!.keys);
      const pockets = posNum(cj.pockets);
      if (pockets !== 37 && pockets !== 38)
        issues.push(err('pockets', 'must be 37 (european) or 38 (american)'));
      const payouts = cj.payouts;
      const n = pockets ?? 37;
      if (!isObj(payouts) || Object.keys(payouts).length === 0) {
        issues.push(err('payouts', 'must define per-bet payouts'));
      } else {
        // Exact per-bet RTP: p = covered/n, RTP = p × payout. Coverage of each
        // canonical bet type on a european wheel; M-01: every listed type must
        // be WINNABLE (p > 0) and no listed payout may exceed maxWin.
        const coverage: Record<string, number> = {
          straight: 1,
          split: 2,
          street: 3,
          corner: 4,
          six_line: 6,
          dozen: 12,
          column: 12,
          red: 18,
          black: 18,
          odd: 18,
          even: 18,
          low: 18,
          high: 18,
          zero: 1,
        };
        let worst = 0;
        let maxPayout = 0;
        for (const [type, multRaw] of Object.entries(payouts)) {
          const mult = num(multRaw);
          if (mult === null || mult <= 0) {
            issues.push(err('payouts', `"${type}" must be a positive number`));
            continue;
          }
          if (!(type in coverage)) {
            issues.push(err('payouts', `unknown bet type "${type}"`));
            continue;
          }
          const rtp = (coverage[type]! / n) * mult * 100;
          if (rtp > CEILING + 0.25)
            issues.push(
              err('payouts', `"${type}" RTP ${rtp.toFixed(2)}% exceeds ${CEILING}%`)
            );
          if (mult > maxWin)
            issues.push(
              err('payouts', `"${type}" pays ${mult}× > maxWinMultiplier ${maxWin}×`)
            );
          worst = Math.max(worst, rtp);
          maxPayout = Math.max(maxPayout, mult);
        }
        return { issues, worstCaseRtp: worst, maxPayout };
      }
      return { issues, worstCaseRtp: 0, maxPayout: 0 };
    },
  },
  'dragon-tiger': {
    keys: ['deck_size', 'ace_high', 'payouts', 'side_bets'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY['dragon-tiger']!.keys);
      const p = cj.payouts;
      if (!isObj(p)) {
        issues.push(err('payouts', 'must define dragon/tiger/tie payouts'));
        return { issues, worstCaseRtp: 0, maxPayout: 0 };
      }
      // Exact 8-deck-infinite-card probabilities: tie on equal ranks:
      // p(tie) = 1/13; each side (1 − 1/13)/2 minus half the ties... exact on
      // infinite deck: p(dragon)=p(tiger)=6/13·(1/2)·2 = 12/26. Use exact:
      const pTie = 1 / 13;
      const pSide = (1 - pTie) / 2;
      const rtpD = pSide * (num(p.dragon) ?? 0) * 100;
      const rtpT = pSide * (num(p.tiger) ?? 0) * 100;
      const rtpTie = pTie * (num(p.tie) ?? 0) * 100;
      const worst = Math.max(rtpD, rtpT, rtpTie);
      const maxPayout = Math.max(
        num(p.dragon) ?? 0,
        num(p.tiger) ?? 0,
        num(p.tie) ?? 0
      );
      if (maxPayout > maxWin)
        issues.push(
          err('payouts', `payout ${maxPayout}× exceeds maxWinMultiplier ${maxWin}×`)
        );
      if (worst > CEILING)
        issues.push(
          err('payouts', `worst bet RTP ${worst.toFixed(2)}% exceeds ${CEILING}%`)
        );
      for (const k of ['dragon', 'tiger', 'tie'] as const)
        if (!posNum(p[k]))
          issues.push(err('payouts', `"${k}" must be a positive number`));
      return { issues, worstCaseRtp: worst, maxPayout };
    },
  },
  baccarat: {
    keys: [
      'decks',
      'payouts',
      'banker_commission_percent',
      'drawing_rules',
      'natural_win',
    ],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.baccarat!.keys);
      const decks = posNum(cj.decks);
      if (!decks || decks < 1 || decks > 8 || !Number.isInteger(decks))
        issues.push(err('decks', '1–8 decks'));
      const p = cj.payouts;
      if (!isObj(p)) {
        issues.push(err('payouts', 'must define player/banker/tie payouts'));
        return { issues, worstCaseRtp: 0, maxPayout: 0 };
      }
      // Exact 8-deck baccarat probabilities (standard drawing rules):
      const pPlayer = 0.4462466;
      const pBanker = 0.4585974;
      const pTie = 0.095156;
      const rtpP = pPlayer * (num(p.player) ?? 0) * 100;
      const rtpB = pBanker * (num(p.banker) ?? 0) * 100;
      const rtpT = pTie * (num(p.tie) ?? 0) * 100;
      const worst = Math.max(rtpP, rtpB, rtpT);
      const maxPayout = Math.max(
        num(p.player) ?? 0,
        num(p.banker) ?? 0,
        num(p.tie) ?? 0
      );
      if (worst > CEILING)
        issues.push(
          err('payouts', `worst bet RTP ${worst.toFixed(2)}% exceeds ${CEILING}%`)
        );
      if (maxPayout > maxWin)
        issues.push(
          err('payouts', `payout ${maxPayout}× exceeds maxWinMultiplier ${maxWin}×`)
        );
      return { issues, worstCaseRtp: worst, maxPayout };
    },
  },
  thimbles: {
    keys: ['cups', 'win_probability', 'payout_multiplier', 'difficulties'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.thimbles!.keys);
      const cups = posNum(cj.cups);
      if (!cups || !Number.isInteger(cups) || cups < 2 || cups > 6)
        issues.push(err('cups', '2–6 cups'));
      const prob = posNum(cj.win_probability);
      if (prob && cups && Math.abs(prob - 1 / cups) > 0.02)
        issues.push(
          err(
            'win_probability',
            `says ${prob} but ${cups} cups imply ${(1 / cups).toFixed(3)} — impossible config`
          )
        );
      const mult = posNum(cj.payout_multiplier);
      if (!mult) issues.push(err('payout_multiplier', 'required positive number'));
      if (prob && mult && prob * mult * 100 > CEILING)
        issues.push(
          err(
            'payout_multiplier',
            `RTP ${(prob * mult * 100).toFixed(2)}% > ${CEILING}%`
          )
        );
      if (mult && mult > maxWin)
        issues.push(
          err('payout_multiplier', `${mult}× exceeds maxWinMultiplier ${maxWin}×`)
        );
      return {
        issues,
        worstCaseRtp: (prob ?? 0) * (mult ?? 0) * 100,
        maxPayout: mult ?? 0,
      };
    },
  },
  wheel: {
    keys: ['tiers'],
    validate: (cj, m) => ({
      ...validateWheelTiers(cj, m),
      issues: expectKeys(cj, ['tiers']).concat(validateWheelTiers(cj, m).issues),
    }),
  },
  'ring-of-fortune': {
    keys: ['tiers'],
    validate: (cj, m) => ({
      ...validateWheelTiers(cj, m),
      issues: expectKeys(cj, ['tiers']).concat(validateWheelTiers(cj, m).issues),
    }),
  },
  wingo: {
    keys: [
      'round_duration_sec',
      'round_durations',
      'bet_lock_sec',
      'number_weights',
      'payouts',
    ],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.wingo!.keys);
      const durations = cj.round_durations;
      if (!Array.isArray(durations) || durations.some((d) => !(num(d)! > 0)))
        issues.push(err('round_durations', 'positive numbers required'));
      const lock = num(cj.bet_lock_sec);
      const dur0 = num(cj.round_duration_sec);
      if (lock !== null && dur0 !== null && (lock < 0 || lock >= dur0))
        issues.push(err('bet_lock_sec', 'must be within the round duration'));
      const weights = cj.number_weights;
      if (Array.isArray(weights)) {
        if (weights.length !== 10)
          issues.push(err('number_weights', 'must cover 0–9 (10 entries)'));
        if (weights.some((w) => !isObj(w) || !(posNum(w.weight) !== null)))
          issues.push(err('number_weights', 'every entry needs a positive weight'));
      } else issues.push(err('number_weights', 'must list 10 numbers with weights'));
      const payouts = cj.payouts;
      if (isObj(payouts)) {
        // v1.3.5·§5: the odds MUST be computed from the configured
        // number_weights, not from an assumed-uniform table — the old code
        // hard-coded {violet: 0.2, number: 0.1, …} right next to the weights
        // it never read, so biasing the draw silently changed real per-choice
        // RTP with zero validation feedback (a measured config took violet
        // from 96% to 11.7% and saved happily).
        const share: number[] = new Array(10).fill(0.1); // uniform fallback
        if (Array.isArray(weights) && weights.length === 10) {
          let sum = 0;
          const raw = new Array(10).fill(10);
          for (const w of weights) {
            if (
              isObj(w) &&
              typeof w.number === 'number' &&
              w.number >= 0 &&
              w.number <= 9
            ) {
              const wt = Number(w.weight);
              if (Number.isFinite(wt) && wt > 0) raw[w.number] = wt;
            }
          }
          sum = raw.reduce((a, b) => a + b, 0);
          for (let i = 0; i < 10; i++) share[i] = sum > 0 ? raw[i]! / sum : 0.1;
        }
        const pRed = share[2]! + share[4]! + share[6]! + share[8]!;
        const pGreen = share[1]! + share[3]! + share[7]! + share[9]!;
        const pViolet = share[0]! + share[5]!;
        const pBig = share[5]! + share[6]! + share[7]! + share[8]! + share[9]!;
        const pSmall = share[0]! + share[1]! + share[2]! + share[3]! + share[4]!;
        const warnings: ConfigIssue[] = [];
        const rtpTable: Record<string, number> = {};
        const probs: Record<string, number> = {
          red: pRed,
          green: pGreen,
          violet: pViolet,
          number: Math.max(...share), // worst-case digit exposure for the cap
          big: pBig,
          small: pSmall,
        };
        const BASELINE_RTP: Record<string, number> = {
          red: 0.4 * 1.96 * 100,
          green: 0.4 * 1.96 * 100,
          violet: 0.2 * 1.96 * 100,
          number: 0.1 * 1.96 * 100,
          big: 0.5 * 1.96 * 100,
          small: 0.5 * 1.96 * 100,
        };
        let worst = 0;
        let maxP = 0;
        for (const [k, v] of Object.entries(payouts)) {
          const mult = num(v);
          if (mult === null || mult <= 0) {
            issues.push(err('payouts', `"${k}" must be positive`));
            continue;
          }
          const p = probs[k];
          if (p === undefined) {
            issues.push(err('payouts', `unknown bet "${k}"`));
            continue;
          }
          const rtp = p * mult * 100;
          rtpTable[k] = Math.round(rtp * 100) / 100;
          if (rtp > CEILING)
            issues.push(
              err(
                'payouts',
                `"${k}" RTP ${rtp.toFixed(2)}% exceeds ${CEILING}% with THESE weights (win chance ${(p * 100).toFixed(2)}% × ${mult}×)`
              )
            );
          if (mult > maxWin)
            issues.push(
              err('payouts', `"${k}" pays ${mult}× > maxWinMultiplier ${maxWin}×`)
            );
          // non-blocking: 1.96× is the live table (color ≈78%, violet ≈39%,
          // number ≈20%, size ≈98%). Warn only on a guts/giveaway vs that.
          if (rtp < 15)
            warnings.push({
              field: 'payouts',
              message: `"${k}" pays back only ${rtp.toFixed(1)}% under these weights (flat 1.96× draw ≈ ${BASELINE_RTP[k]!.toFixed(1)}%) — players will bleed on this bet`,
            });
          else if (rtp > 99)
            warnings.push({
              field: 'payouts',
              message: `"${k}" pays back ${rtp.toFixed(1)}% under these weights — the house margin here is almost gone`,
            });
          worst = Math.max(worst, rtp);
          maxP = Math.max(maxP, mult);
        }
        // per-digit view: the same number multiplier prices every digit, so a
        // heavied digit hurts players and a hollowed one is a dead bet.
        const numMult = num(payouts.number);
        if (numMult !== null && numMult > 0) {
          let minRtp = Infinity;
          let maxRtp = 0;
          let minN = 0;
          let maxN = 0;
          for (let n = 0; n < 10; n++) {
            const r = share[n]! * numMult * 100;
            if (r < minRtp) {
              minRtp = r;
              minN = n;
            }
            if (r > maxRtp) {
              maxRtp = r;
              maxN = n;
            }
          }
          if (minRtp < 15 && minRtp !== maxRtp)
            warnings.push({
              field: 'number_weights',
              message: `number ${minN} pays back only ${minRtp.toFixed(1)}% while number ${maxN} pays ${maxRtp.toFixed(1)}% — the digits under the same "number" price are wildly unequal`,
            });
        }
        return { issues, warnings, rtpTable, worstCaseRtp: worst, maxPayout: maxP };
      }
      issues.push(
        err('payouts', 'must define red/green/violet/number/big/small payouts')
      );
      return { issues, worstCaseRtp: 0, maxPayout: 0 };
    },
  },
  plinko: {
    keys: ['default_rows', 'default_risk', 'risk_levels'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.plinko!.keys);
      const risks = cj.risk_levels;
      if (!isObj(risks) || Object.keys(risks).length === 0) {
        issues.push(err('risk_levels', 'must define at least one risk level'));
        return { issues, worstCaseRtp: 0, maxPayout: 0 };
      }
      let worst = 0;
      let maxP = 0;
      for (const [risk, rowsTable] of Object.entries(risks)) {
        if (!isObj(rowsTable)) {
          issues.push(
            err('risk_levels', `"${risk}" must map rows → multiplier arrays`)
          );
          continue;
        }
        for (const [rowsRaw, table] of Object.entries(rowsTable)) {
          const rows = parseInt(rowsRaw, 10);
          if (!Number.isInteger(rows) || rows < 2 || rows > 32) {
            issues.push(err('risk_levels', `"${risk}" rows "${rowsRaw}" must be 2–32`));
            continue;
          }
          if (!Array.isArray(table) || table.length !== rows + 1) {
            issues.push(
              err(
                'risk_levels',
                `"${risk}" rows ${rows} needs exactly ${rows + 1} buckets`
              )
            );
            continue;
          }
          // EXACT per-row RTP: bucket i lands with probability C(rows,i)/2^rows.
          const norm = Math.pow(2, rows);
          let rtp = 0;
          let localMax = 0;
          const mults = table.map(num);
          if (mults.some((x) => x === null)) {
            issues.push(
              err('risk_levels', `"${risk}" rows ${rows} has non-numeric entries`)
            );
            continue;
          }
          for (let i = 0; i <= rows; i++) {
            rtp += (comb(rows, i) / norm) * mults[i]!;
            if (mults[i]! > localMax) localMax = mults[i]!;
          }
          if (rtp * 100 > CEILING + 0.5)
            issues.push(
              err(
                'risk_levels',
                `"${risk}" rows ${rows} exact RTP ${(rtp * 100).toFixed(2)}% > ${CEILING}%`
              )
            );
          if (localMax > maxP) maxP = localMax;
          worst = Math.max(worst, rtp * 100);
        }
      }
      if (maxP > maxWin)
        issues.push(
          err(
            'risk_levels',
            `bucket payout ${maxP}× exceeds maxWinMultiplier ${maxWin}×`
          )
        );
      const dr = cj.default_risk;
      if (dr !== undefined && !Object.keys(risks).includes(String(dr)))
        issues.push(
          err('default_risk', `must be one of: ${Object.keys(risks).join(', ')}`)
        );
      return { issues, worstCaseRtp: worst, maxPayout: maxP };
    },
  },
  mines: {
    keys: ['grid_size', 'mine_counts', 'mine_placement'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.mines!.keys);
      const grid = posNum(cj.grid_size);
      if (!grid || !Number.isInteger(grid) || grid < 4 || grid > 36)
        issues.push(err('grid_size', '4–36 tiles'));
      const counts = cj.mine_counts;
      if (!Array.isArray(counts) || counts.length === 0)
        issues.push(err('mine_counts', 'must list allowed mine counts'));
      else {
        for (const c of counts) {
          const n = num(c);
          if (n === null || !Number.isInteger(n) || n < 1)
            issues.push(err('mine_counts', 'counts must be positive ints'));
          else if (grid && n >= grid)
            issues.push(
              err(
                'mine_counts',
                `${n} mines on a ${grid}-tile grid leaves no safe tile (impossible choice)`
              )
            );
        }
      }
      // Ladder derived by handler: 0.96 × C(grid,k)/C(grid-m,k); max = last rung of the
      // tightest mine count where digging every safe tile pays ≤ 0.96 × C(grid, m×...)
      // structural RTP 96% — assert the derived maximum against the cap.
      let maxPayout = 0;
      if (grid && Array.isArray(counts)) {
        for (const c of counts as number[]) {
          if (!Number.isInteger(c) || c < 1 || c >= grid) continue;
          const safe = grid - c;
          // Exact derived full-clear multiplier: multiply inverse survival
          // odds dig-by-dig (same derivation the handler's fair ladder uses).
          let mult = 0.96;
          for (let dug = 0; dug < safe; dug++) {
            const tilesLeft = grid - dug;
            const safeLeft = safe - dug;
            mult /= safeLeft / tilesLeft;
          }
          if (Number.isFinite(mult) && mult > maxPayout) maxPayout = mult;
        }
        if (maxPayout > maxWin && maxWin > 0)
          issues.push(
            err(
              'mine_counts',
              `derived full-clear multiplier ${maxPayout.toFixed(0)}× exceeds maxWinMultiplier ${maxWin}×`
            )
          );
      }
      return { issues, worstCaseRtp: 96, maxPayout };
    },
  },
  'hi-lo': {
    keys: ['deck_size', 'payout_per_correct', 'streak_bonus_multiplier', 'max_streak'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY['hi-lo']!.keys);
      const deck = posNum(cj.deck_size);
      if (!deck || deck < 26 || deck > 416)
        issues.push(err('deck_size', 'realistic deck size (26–416)'));
      const maxStreak = cj.max_streak;
      if (maxStreak !== undefined && (num(maxStreak) === null || num(maxStreak)! < 1))
        issues.push(err('max_streak', 'positive int required'));
      const sbm = cj.streak_bonus_multiplier;
      if (sbm !== undefined && num(sbm) === null)
        issues.push(err('streak_bonus_multiplier', 'must be a number'));
      // payouts are derived dynamically per guess (payout_per_correct: 'dynamic')
      // — RTP structural (fair per-pick odds).
      return { issues, worstCaseRtp: 97, maxPayout: Math.min(maxWin, 100) };
    },
  },
  'lucky-number': {
    keys: ['min', 'max', 'payout_ladder'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY['lucky-number']!.keys);
      const min = num(cj.min);
      const max = num(cj.max);
      if (
        min === null ||
        max === null ||
        max <= min ||
        !Number.isInteger(min) ||
        !Number.isInteger(max)
      )
        issues.push(err('min', 'need integer min < max'));
      const N = min !== null && max !== null ? max - min + 1 : 0;
      const ladder = cj.payout_ladder;
      let maxPayout = 0;
      let worst = 0;
      if (ladder !== undefined) {
        if (!Array.isArray(ladder) || ladder.length === 0)
          issues.push(err('payout_ladder', 'non-empty when present'));
        else {
          for (const rung of ladder) {
            if (!isObj(rung)) continue;
            const mult = num(rung.multiplier);
            const maxDelta = num(rung.max_delta);
            if (mult === null || mult < 0)
              issues.push(err('payout_ladder', 'multipliers ≥ 0'));
            if (maxDelta === null || maxDelta < 0 || maxDelta >= N)
              issues.push(err('payout_ladder', `max_delta must be in [0, ${N})`));
            if (mult !== null && maxDelta !== null && N > 0) {
              // p(win) = width of the delta band / N
              const width = Math.min(N, 2 * maxDelta + 1);
              const rtp = (width / N) * mult * 100;
              if (rtp > CEILING + 0.5)
                issues.push(
                  err(
                    'payout_ladder',
                    `rung delta≤${maxDelta} pays ${mult}× → RTP ${rtp.toFixed(2)}% > ${CEILING}%`
                  )
                );
              worst = Math.max(worst, rtp);
              maxPayout = Math.max(maxPayout, mult);
            }
          }
        }
      }
      if (maxPayout > maxWin)
        issues.push(
          err(
            'payout_ladder',
            `payout ${maxPayout}× exceeds maxWinMultiplier ${maxWin}×`
          )
        );
      return { issues, worstCaseRtp: worst, maxPayout };
    },
  },
  stairs: {
    keys: ['steps', 'visual', 'choices_per_step', 'safe_per_step', 'payout_ladder'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.stairs!.keys);
      const steps = posNum(cj.steps);
      const per = posNum(cj.choices_per_step);
      const safe = posNum(cj.safe_per_step);
      if (!steps || steps < 1 || steps > 50) issues.push(err('steps', '1–50 steps'));
      if (!per || per < 2) issues.push(err('choices_per_step', '≥ 2 choices'));
      if (per && safe && safe >= per)
        issues.push(
          err(
            'safe_per_step',
            'must be strictly fewer than choices_per_step (else guaranteed win)'
          )
        );
      if (per && safe !== null && safe !== undefined && safe < 1)
        issues.push(err('safe_per_step', 'must be ≥ 1 (else guaranteed loss)'));
      const ladder = cj.payout_ladder;
      let maxPayout = 0;
      if (ladder !== undefined) {
        if (!Array.isArray(ladder) || ladder.length === 0)
          issues.push(err('payout_ladder', 'non-empty when present'));
        else {
          if (steps && ladder.length < steps)
            issues.push(
              err(
                'payout_ladder',
                `needs a rung for every one of ${steps} steps (has ${ladder.length})`
              )
            );
          for (const multRaw of ladder) {
            const mult = num(multRaw);
            if (mult === null || mult <= 0)
              issues.push(err('payout_ladder', 'multipliers must be > 0'));
            else {
              if (mult <= 1)
                issues.push(
                  err(
                    'payout_ladder',
                    `rung ${mult}× is a guaranteed loss even on success`
                  )
                );
              if (mult > maxPayout) maxPayout = mult;
            }
          }
          // derived p(top) = (safe/per)^steps → fair top payout ≈ 0.96 × (per/safe)^steps
          if (per && safe && steps) {
            const fairTop = 0.96 * Math.pow(per / safe, steps);
            const top = num(ladder[ladder.length - 1]) ?? 0;
            if (top > fairTop * 1.15)
              issues.push(
                err(
                  'payout_ladder',
                  `top rung ${top}× exceeds fair odds ${fairTop.toFixed(0)}× by >15% (RTP blowout)`
                )
              );
          }
        }
      }
      if (maxPayout > maxWin)
        issues.push(
          err(
            'payout_ladder',
            `ladder top ${maxPayout}× exceeds maxWinMultiplier ${maxWin}×`
          )
        );
      return { issues, worstCaseRtp: 96, maxPayout };
    },
  },
  tower: {
    // ENGINE CONTRACT (gameSessions.ts / resolveTowerBoard): `floors` +
    // `difficulties` { columns_per_floor, traps_per_floor, payout_ladder? }.
    // Top-level `payout_ladder_{easy,medium,hard,expert}` is the legacy
    // shape — both are accepted. A missing ladder falls back to the fair
    // 0.96/p^f formula (expert floor 10 ≈ 9.4M×).
    keys: [
      'floors',
      'difficulties',
      'payout_ladder_easy',
      'payout_ladder_medium',
      'payout_ladder_hard',
      'payout_ladder_expert',
    ],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY.tower!.keys);
      const floors = num(cj.floors);
      if (floors === null || !Number.isInteger(floors) || floors < 1 || floors > 50)
        issues.push(err('floors', 'must be a positive int ≤ 50'));
      const levels = floors ?? SHARED_TOWER_FLOORS;
      const difficulties = cj.difficulties;
      let maxPayout = 0;
      let worstRtp = 0;
      if (!isObj(difficulties) || Object.keys(difficulties).length === 0) {
        issues.push(err('difficulties', 'must define at least one'));
      } else {
        for (const [name, d] of Object.entries(difficulties)) {
          if (!isObj(d)) {
            issues.push(err('difficulties', `"${name}" must be an object`));
            continue;
          }
          for (const k of ['columns_per_floor', 'traps_per_floor'] as const) {
            const v = num(d[k]);
            if (v === null || !Number.isInteger(v) || v < 1)
              issues.push(err('difficulties', `"${name}.${k}" must be a positive int`));
          }
          const cols = num(d.columns_per_floor) ?? 0;
          const traps = num(d.traps_per_floor) ?? 0;
          if (cols > 0 && traps >= cols)
            issues.push(
              err(
                'difficulties',
                `"${name}" has traps ≥ columns — a guaranteed-loss difficulty`
              )
            );
          const nested = parseTowerLadder(d.payout_ladder, levels);
          const top = parseTowerLadder(cj[`payout_ladder_${name}`], levels);
          const configured = nested ?? top;
          if (configured) {
            const p = cols > traps && cols > 0 ? (cols - traps) / cols : 0;
            configured.forEach((mult, i) => {
              if (mult <= 1)
                issues.push(
                  err(
                    `payout_ladder_${name}`,
                    `floor ${i + 1} pays ${mult}× — a guaranteed loss even on success`
                  )
                );
              if (mult > maxPayout) maxPayout = mult;
              if (p > 0) {
                const rtp = Math.pow(p, i + 1) * mult * 100;
                if (rtp > CEILING)
                  issues.push(
                    err(
                      `payout_ladder_${name}`,
                      `floor ${i + 1} ${mult}× → RTP ${rtp.toFixed(2)}% exceeds the ${CEILING}% ceiling (survive chance ${(Math.pow(p, i + 1) * 100).toFixed(4)}%)`
                    )
                  );
                if (rtp > worstRtp) worstRtp = rtp;
              }
            });
            if (d.payout_ladder !== undefined && nested === null)
              issues.push(
                err(
                  'difficulties',
                  `"${name}.payout_ladder" needs ${levels} finite multipliers > 0`
                )
              );
          } else if (
            d.payout_ladder !== undefined ||
            cj[`payout_ladder_${name}`] !== undefined
          ) {
            issues.push(
              err(
                `payout_ladder_${name}`,
                `needs a rung for every one of ${levels} floors`
              )
            );
          } else if (cols > traps && traps > 0 && levels > 0) {
            // no admin table — engine will derive fair 0.96/p^f
            const fair = fairTowerLadder(cols, traps, levels);
            const topFair = fair[fair.length - 1] ?? 0;
            if (topFair > maxPayout) maxPayout = topFair;
            worstRtp = Math.max(worstRtp, 96);
          }
        }
        if (
          maxPayout > Math.min(maxWin, LIMITS.MAX_WIN_MULTIPLIER_LIMIT) &&
          maxPayout !== 0
        )
          issues.push(
            err(
              'difficulties',
              `top payout ${maxPayout.toExponential(1)}× exceeds financed max ${maxWin}× — lower a floor multiplier or raise maxWinMultiplier`
            )
          );
      }
      return { issues, worstCaseRtp: worstRtp || 96, maxPayout };
    },
  },
  'scratch-card': {
    keys: ['grid', 'symbols', 'win_combos'],
    validate: (cj, maxWin) => {
      const issues = expectKeys(cj, REGISTRY['scratch-card']!.keys);
      const grid = cj.grid;
      let rows = 3,
        cols = 3;
      if (isObj(grid)) {
        rows = posNum(grid.rows) ?? 0;
        cols = posNum(grid.cols) ?? 0;
        if (!rows || !cols || rows * cols < 3 || rows * cols > 25)
          issues.push(err('grid', 'rows×cols 3–25'));
      } else issues.push(err('grid', '{rows, cols} required'));
      const symbols = cj.symbols;
      let totalW = 0;
      if (!Array.isArray(symbols) || symbols.length < 2) {
        issues.push(err('symbols', 'needs ≥ 2 weighted symbols'));
      } else {
        for (const s of symbols) {
          if (!isObj(s) || typeof s.symbol !== 'string' || !posNum(s.weight))
            issues.push(err('symbols', 'each needs {symbol, weight>0}'));
          else totalW += posNum(s.weight)!;
        }
      }
      const combos = cj.win_combos;
      let maxPayout = 0;
      if (!Array.isArray(combos) || combos.length === 0) {
        issues.push(err('win_combos', 'must list winning combinations'));
      } else {
        for (const c of combos) {
          if (!isObj(c)) continue;
          const count = posNum(c.count);
          const mult = posNum(c.multiplier);
          if (!count || !mult) {
            issues.push(err('win_combos', 'each combo needs {count, multiplier} > 0'));
            continue;
          }
          if (count > rows * cols)
            issues.push(
              err(
                'win_combos',
                `count ${count} larger than the ${rows * cols}-cell grid`
              )
            );
          if (mult > maxPayout) maxPayout = mult;
        }
        if (maxPayout > maxWin)
          issues.push(
            err('win_combos', `combo pays ${maxPayout}× > maxWinMultiplier ${maxWin}×`)
          );
      }
      // Deterministic Monte-Carlo RTP (seeded, 100k cards — stable to ±0.3%)
      let worstRtp = 0;
      if (totalW > 0 && Array.isArray(combos) && Array.isArray(symbols)) {
        const cells = rows * cols;
        const rng = mulberry32(0x9e3779b9);
        let paid = 0;
        const N = 100_000;
        const probs = (symbols as Array<Record<string, unknown>>).map(
          (s) => (posNum(s.weight) ?? 0) / totalW
        );
        const cump: number[] = [];
        let acc = 0;
        for (const p of probs) cump.push((acc += p));
        const comboRules = (combos as Array<Record<string, unknown>>)
          .map((c) => ({
            sym: String(c.symbol ?? ''),
            count: posNum(c.count) ?? 0,
            mult: posNum(c.multiplier) ?? 0,
          }))
          .filter((c) => c.count > 0 && c.mult > 0);
        const symIds = (symbols as Array<Record<string, unknown>>).map((s) =>
          String(s.symbol)
        );
        for (let card = 0; card < N; card++) {
          // ENGINE-TRUE model (ScratchCardGame.sampleOutcome): a card pays only
          // when a whole ROW is the same symbol ("3 in a row"); never "count
          // anywhere on the card" — the old sim counted totals across all cells
          // and called a ~96% table 630%.
          const grid: string[] = [];
          for (let i = 0; i < cells; i++) {
            const r = rng();
            let k = 0;
            while (k < cump.length - 1 && cump[k]! < r) k++;
            grid.push(symIds[k]!);
          }
          let best = 0;
          for (let row = 0; row < rows; row++) {
            const line = grid.slice(row * cols, row * cols + cols);
            if (line.every((c) => c === line[0])) {
              const c = comboRules.find((x) => x.sym === line[0]);
              if (c && c.mult > best) best = c.mult;
            }
          }
          paid += best;
        }
        worstRtp = (paid / N) * 100;
        if (worstRtp > CEILING + 1)
          issues.push(
            err(
              'win_combos',
              `simulated RTP ${worstRtp.toFixed(2)}% (100k cards) exceeds the ${CEILING}% ceiling`
            )
          );
      }
      return { issues, worstCaseRtp: worstRtp, maxPayout };
    },
  },
};

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * C-06 entry point. Validates a game's (merged) configJson against the game's
 * STRICT schema and its per-choice RTP/liability bounds. `maxWinMultiplier`
 * comes from the top-level config columns.
 */
export function validateGameConfigJson(
  slug: string,
  configJson: unknown,
  maxWinMultiplier: number
): GameConfigCheck {
  const entry = REGISTRY[slug];
  if (!entry) {
    // Unknown game: nothing to be strict about (generic validateConfig still runs).
    return { ok: true, issues: [], worstCaseRtp: 0, maxPayout: 0 };
  }
  const cj = isObj(configJson) ? configJson : {};
  const maxWin =
    Number.isFinite(maxWinMultiplier) && maxWinMultiplier > 0
      ? maxWinMultiplier
      : Infinity;
  const { issues, warnings, rtpTable, worstCaseRtp, maxPayout } = entry.validate(
    cj,
    maxWin
  ) as GameConfigCheck & { issues: ConfigIssue[] };
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    rtpTable,
    worstCaseRtp,
    maxPayout,
  };
}

/** The slugs with strict schemas (for tests + panel discoverability). */
export const STRICTLY_VALIDATED_GAMES = Object.keys(REGISTRY);

/**
 * Admin PATCH keys that never change settlement math. Hiding a game, pinning
 * it as Hot, renaming it, etc. must succeed even when leftover odds fields
 * would fail the generic RTP ceiling (Aviator seed `payout_weights` ≈ 213%).
 */
export const GAME_OPERATIONAL_PATCH_KEYS = new Set([
  'isActive',
  'isFeatured',
  'demoEnabled',
  'displayName',
  'description',
  'thumbnailUrl',
  'category',
  'tags',
  'sortOrder',
  'animationSpeed',
  'updatedBy',
]);

export function patchTouchesOdds(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some(
    (k) => !GAME_OPERATIONAL_PATCH_KEYS.has(k) && patch[k] !== undefined
  );
}

/**
 * Crash games settle from HMAC + `crash_distribution`, never `payout_weights`.
 * The generic winRate × mean(weights) check is the wrong lever for them.
 */
export const GENERIC_PAYOUT_WEIGHT_EXEMPT = new Set(['aviator', 'crash-x']);

export function usesGenericPayoutWeights(slug: string): boolean {
  return !GENERIC_PAYOUT_WEIGHT_EXEMPT.has(slug);
}
