// apps/api/prisma/seed.ts — idempotent seed (docs/19 §16 + docs/20 §6 canonical)
// Run: pnpm db:seed
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const DEFAULT_SETTINGS: Record<string, unknown> = {
  coin_rate: 1.0,
  min_deposit: 10,
  min_withdrawal: 20,
  withdrawal_fee_percent: 2.0,
  withdrawal_fee_flat: 0,
  global_max_win_multiplier: 25,
  // H-1: platform-wide stake ceiling. minBet was enforced nowhere and there was
  // no maximum at all beyond zod's .positive(), so R0.01 dust bets were legal
  // (farmable against flat-amount bonuses) and there was no cap on the top end.
  // A per-game `max_bet` in configJson overrides this downwards.
  // The platform-wide MINIMUM stake. A game may raise its own floor above this
  // (GameConfig.minBet) but can never go below it, so one admin field controls
  // the real minimum everywhere instead of 20 separate per-game numbers.
  global_min_bet: 10,
  global_max_bet: 500000,
  // The most any single round may pay out, in MONEY. maxWinMultiplier caps the
  // multiplier only, so a big enough stake on a high-multiplier game had no
  // ceiling in currency terms at all.
  global_max_payout: 5000000,
  rtp_ceiling: 99, // HARD CODED, display only — never editable
  // Minimum wallet balance required to claim the daily bonus. Without this the
  // ladder is a faucet that throwaway accounts can farm forever.
  daily_checkin_min_balance: 100,
  // Admin-configurable welcome bonus, credited to the BONUS wallet at signup.
  signup_bonus_enabled: false,
  signup_bonus_amount: 0,
  daily_checkin_ladder: [
    { day: 1, bonus: 5 },
    { day: 2, bonus: 8 },
    { day: 3, bonus: 12 },
    { day: 4, bonus: 18 },
    { day: 5, bonus: 25 },
    { day: 6, bonus: 35 },
    { day: 7, bonus: 50 },
    { day: 14, bonus: 75 },
    { day: 21, bonus: 100 },
    { day: 30, bonus: 200 },
  ],
  win_streak_milestones: [
    { wins: 5, bonus: 25 },
    { wins: 10, bonus: 75 },
    { wins: 25, bonus: 250 },
  ],
  rakeback_percent: 5.0,
  referral_bonus_referrer: 25,
  referral_bonus_referee: 10,
  // Master switch — there was none, so referral bonuses were always live.
  // Default true to preserve current behaviour; the payout TRIGGER is what
  // changed (first approved deposit, not signup).
  referral_bonus_enabled: true,
  // Cap on how many rewards one referrer can be paid. 0 = unlimited: a farmer
  // cannot approve their own deposits, so the deposit trigger is already the
  // real control. Set a number to bound the blast radius further.
  referral_max_rewards: 0,
  // % of referred users' net spend paid daily to referral agents.
  referral_commission_pct: 5.0,
  session_reminder_default_min: 60,
  maintenance_mode: false,
  registration_open: true,
  big_win_ticker_threshold: 500,
  // D-073: demo mode master switch — OFF by default (guests must log in to play).
  demo_mode_enabled: false,
  lobby_show_game_names: false,
  idle_logout_hours: 24,
  seed_rotation_after_rounds: 1000,
  bet_spend_priority: ['BONUS', 'GIFTED', 'REAL'],
  leaderboard_metric: 'total_wagered',
  ENABLE_DEMO_MODE: true,
  ENABLE_REFERRAL_PROGRAM: true,
  ENABLE_LEADERBOARD: true,
  ENABLE_RAKEBACK: true,
  ENABLE_WIN_STREAKS: true,
  ENABLE_COIN_GIFTS: true,
};

// 20-game registry (docs/04 + docs/13); configJson per game spec
const GAMES: Array<Record<string, unknown>> = [
  {
    slug: 'aviator',
    displayName: 'Aviator',
    description: 'Cash out before the plane flies away!',
    category: ['crash', 'popular'],
    tags: ['hot', 'multiplayer'],
    sortOrder: 1,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 100,
    minBet: 10,
    configJson: {
      round_interval_ms: 5000,
      tick_interval_ms: 50,
      base_speed: 0.06,
      growth_rate: 0.00016,
      // Calibrated for 96% RTP: P(crash >= T) ≈ 0.96/T at every target (verified
      // by sim — 96.1–98% across 1.05×–25×, 100% at 100×; docs/13 AVIATOR)
      crash_distribution: {
        '1.00-1.10': 12.7,
        '1.10-1.50': 23.3,
        '1.50-2.00': 16.0,
        '2.00-3.00': 16.0,
        '3.00-5.00': 12.8,
        '5.00-10.00': 9.6,
        '10.00-25.00': 5.8,
        // C-04: tail folded into the 100× cap. The engine clamps payouts at
        // maxWinMultiplier (100) — a sampled crash point above 100 pays exactly
        // 100×, so moving the old '100.00+' weight to 100 keeps P(crash ≥ T)
        // identical for every cashout target ≤100× (RTP unchanged), while the
        // strict seed validator no longer sees a tail above the cap.
        '25.00-100.00': 3.9,
      },
      payout_weights: [
        { multiplier: 1.5, weight: 30 },
        { multiplier: 2.0, weight: 25 },
        { multiplier: 3.0, weight: 20 },
        { multiplier: 5.0, weight: 12 },
        { multiplier: 10.0, weight: 8 },
        { multiplier: 25.0, weight: 4 },
        { multiplier: 50.0, weight: 1 },
      ],
    },
  },
  {
    slug: 'plinko',
    displayName: 'Plinko',
    category: ['casual', 'popular'],
    tags: ['popular'],
    sortOrder: 2,
    baseRtp: 95,
    winRate: 48,
    // v1.3.9: hard-capped at 12x per operator order (was 200 — the bucket
    // tables are the real ladder now; this is the belt-and-braces money cap).
    maxWinMultiplier: 12,
    minBet: 10,
    configJson: {
      default_rows: 12,
      default_risk: 'medium',
      risk_levels: {
        low: {
          '8': [2, 1.34, 1.02, 0.904, 0.887, 0.904, 1.02, 1.34, 2],
          '12': [
            2, 1.56, 1.25, 1.06, 0.959, 0.924, 0.919, 0.924, 0.959, 1.06, 1.25, 1.56, 2,
          ],
          '16': [
            2, 1.68, 1.4, 1.21, 1.07, 0.992, 0.95, 0.935, 0.933, 0.935, 0.95, 0.992,
            1.07, 1.21, 1.4, 1.68, 2,
          ],
        },
        medium: {
          '8': [6, 3, 1.3, 0.7, 0, 0.7, 1.3, 3, 6],
          '12': [6, 4.5, 3.5, 2, 1.1, 0.55, 0, 0.55, 1.1, 2, 3.5, 4.5, 6],
          '16': [6, 5.5, 5, 4, 2.5, 1.6, 0.9, 0.5, 0, 0.5, 0.9, 1.6, 2.5, 4, 5, 5.5, 6],
        },
        high: {
          '8': [12, 3.5, 0.8, 0, 0, 0, 0.8, 3.5, 12],
          '12': [12, 7, 4, 1.6, 0.5, 0, 0, 0, 0.5, 1.6, 4, 7, 12],
          '16': [12, 9, 7, 4.5, 2.2, 1, 0.4, 0, 0, 0, 0.4, 1, 2.2, 4.5, 7, 9, 12],
        },
      },
    },
  },
  {
    slug: 'wingo',
    displayName: 'Win Go',
    category: ['lottery', 'popular'],
    tags: ['popular', 'multiplayer'],
    sortOrder: 3,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 10,
    minBet: 10,
    configJson: {
      round_duration_sec: 30,
      round_durations: [30, 60, 180, 300],
      bet_lock_sec: 5,
      number_weights: Array.from({ length: 10 }, (_, number) => ({
        number,
        weight: 10,
      })),
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
  {
    slug: 'mines',
    displayName: 'Mines',
    category: ['casual', 'popular'],
    tags: [],
    sortOrder: 4,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 10000,
    minBet: 10, // NO payout_ladders: the engine derives the mathematically fair ladder from the
    // mine count (0.96 x C(25,k)/C(25-m,k)). The hand-written tables that used to live
    // here paid up to 344% RTP at deep levels and were TRUNCATED (10 mines had 10 rungs
    // for 15 safe tiles), so digs past the end carried risk for no extra reward.
    configJson: {
      grid_size: 25,
      // fair full-clear = 0.96 × C(25, mines): 1→24×, 2→288×, 3→2,208× (≤ 10,000× cap).
      // 4+ mines derives 12,144×–3.1M× — ABOVE the 10,000× payout clamp, so those
      // counts could never pay their fair ladder (players silently shorted past the
      // cap). Removed until maxWinMultiplier is raised WITH a finance review;
      // payouts for the remaining counts are unchanged from before.
      mine_counts: [1, 2, 3],
      mine_placement: 'weighted',
    },
  },
  {
    slug: 'dice',
    displayName: 'Dice',
    category: ['dice', 'provably-fair'],
    tags: [],
    sortOrder: 5,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 25,
    minBet: 10,
    configJson: {
      min_target: 2,
      max_target: 98,
      segments: [
        { range: [1, 10], weight: 1.0 },
        { range: [11, 50], weight: 1.2 },
        { range: [51, 90], weight: 1.0 },
        { range: [91, 100], weight: 0.8 },
      ],
    },
  },
  {
    slug: 'wheel',
    displayName: 'Wheel of Fortune',
    category: ['casual'],
    tags: [],
    sortOrder: 6,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 50,
    minBet: 10, // The player BACKS A COLOUR TIER (it used to have no decision at all).
    // Each tier pays 0.96 / P(tier) -> all four return ~96% RTP.
    configJson: {
      tiers: [
        { id: 'yellow', label: '2x', color: '#f5c842', slices: 12 },
        { id: 'blue', label: '3x', color: '#4d9fff', slices: 8 },
        { id: 'green', label: '5x', color: '#00d97e', slices: 3 },
        { id: 'purple', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
      ],
    },
  },
  {
    slug: 'coin-flip',
    displayName: 'Coin Flip',
    category: ['casual'],
    tags: [],
    sortOrder: 7,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 10,
    minBet: 10,
    configJson: { options: ['heads', 'tails'], payout: 1.92, win_probability: 0.5 },
  },
  {
    slug: 'tower',
    displayName: 'Tower',
    category: ['casual'],
    tags: [],
    sortOrder: 8,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 1000,
    minBet: 10,
    // Admin-owned per-floor × (panel → Tower → Floor payouts). Without these
    // the engine falls back to fair 0.96/p^f (expert floor 10 ≈ 9.4 million ×).
    // Nested payout_ladder is what the client and towerSession both read.
    configJson: {
      floors: 10,
      difficulties: {
        easy: {
          columns_per_floor: 3,
          traps_per_floor: 1,
          payout_ladder: [1.4, 1.75, 2.2, 2.75, 3.45, 4.3, 5.4, 6.75, 8.4, 10.5],
        },
        medium: {
          columns_per_floor: 4,
          traps_per_floor: 2,
          payout_ladder: [1.85, 2.6, 3.65, 5.1, 7.1, 10, 14, 19.5, 27, 38],
        },
        hard: {
          columns_per_floor: 4,
          traps_per_floor: 3,
          payout_ladder: [3.5, 5.5, 8.6, 13.5, 21, 33, 52, 82, 130, 200],
        },
        expert: {
          columns_per_floor: 5,
          traps_per_floor: 4,
          payout_ladder: [4.4, 7.5, 13, 22, 38, 65, 110, 185, 310, 520],
        },
      },
      payout_ladder_easy: [1.4, 1.75, 2.2, 2.75, 3.45, 4.3, 5.4, 6.75, 8.4, 10.5],
      payout_ladder_medium: [1.85, 2.6, 3.65, 5.1, 7.1, 10, 14, 19.5, 27, 38],
      payout_ladder_hard: [3.5, 5.5, 8.6, 13.5, 21, 33, 52, 82, 130, 200],
      payout_ladder_expert: [4.4, 7.5, 13, 22, 38, 65, 110, 185, 310, 520],
    },
  },
  {
    slug: 'hi-lo',
    displayName: 'Hi-Lo',
    category: ['card'],
    tags: [],
    sortOrder: 9,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 100,
    minBet: 10,
    configJson: {
      deck_size: 52,
      payout_per_correct: 'dynamic',
      streak_bonus_multiplier: 1.0,
      max_streak: 20,
    },
  },
  {
    slug: 'limbo',
    displayName: 'Limbo',
    category: ['dice', 'provably-fair'],
    tags: [],
    sortOrder: 10,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 1000,
    minBet: 10,
    configJson: {
      min_target: 1.01,
      // payouts = target × 0.99 clamped at maxWinMultiplier — a target above the
      // cap would be priced fair but paid capped (rigged). max_target must equal
      // the 1000× cap so every accepted target pays what it advertises.
      max_target: 1000,
      distribution_curve: 'exponential',
      rtp_adjustment_factor: 0.99,
    },
  },
  {
    slug: 'keno',
    displayName: 'Keno',
    category: ['lottery'],
    tags: [],
    sortOrder: 11,
    baseRtp: 95,
    winRate: 48,
    // cap covers the highest table payout (10-picks full match = 250×);
    // a lower cap would truncate advertised jackpot payouts.
    maxWinMultiplier: 250,
    minBet: 10,
    configJson: {
      grid_size: 40,
      max_picks: 10,
      draw_count: 20,
      draw_weights: null,
      payout_tables: {
        '1_picks': { '0': 0, '1': 1.92 },
        '2_picks': { '0': 0, '1': 0.07, '2': 3.75 },
        '3_picks': { '0': 0, '1': 0.07, '2': 0.02, '3': 8.0 },
        '4_picks': { '0': 0, '1': 0.13, '2': 0.02, '3': 0.01, '4': 17.25 },
        '5_picks': { '0': 0, '1': 1.72, '2': 0.19, '3': 0.09, '4': 0.11, '5': 25.0 },
        '6_picks': {
          '0': 0,
          '1': 0.05,
          '2': 0.1,
          '3': 0.3,
          '4': 1.0,
          '5': 3.0,
          '6': 34.0,
        },
        '7_picks': {
          '0': 0,
          '1': 0.05,
          '2': 0.1,
          '3': 0.25,
          '4': 0.7,
          '5': 2.0,
          '6': 7.0,
          '7': 12.0,
        },
        '8_picks': {
          '0': 0,
          '1': 0.05,
          '2': 0.1,
          '3': 0.15,
          '4': 0.4,
          '5': 0.8,
          '6': 2.5,
          '7': 8.0,
          '8': 130.0,
        },
        '9_picks': {
          '0': 0,
          '1': 0.05,
          '2': 0.1,
          '3': 0.12,
          '4': 0.25,
          '5': 0.5,
          '6': 1.5,
          '7': 4.0,
          '8': 20.0,
          '9': 140.0,
        },
        '10_picks': {
          '0': 0,
          '1': 0.05,
          '2': 0.1,
          '3': 0.12,
          '4': 0.2,
          '5': 0.4,
          '6': 1.0,
          '7': 2.0,
          '8': 8.0,
          '9': 20.0,
          '10': 250.0,
        },
      },
    },
  },
  {
    slug: 'dragon-tiger',
    displayName: 'Dragon Tiger',
    category: ['card'],
    tags: [],
    sortOrder: 12,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 15,
    minBet: 10,
    configJson: {
      deck_size: 52,
      ace_high: true,
      payouts: { dragon: 1.95, tiger: 1.95, tie: 12.46 },
      side_bets: { dragon_suit: false, tiger_suit: false },
    },
  },
  {
    slug: 'roulette',
    displayName: 'Roulette',
    category: ['table'],
    tags: [],
    sortOrder: 13,
    baseRtp: 95.3,
    winRate: 48,
    maxWinMultiplier: 36,
    minBet: 10,
    configJson: {
      pockets: 37,
      zero: { value: 0, color: 'green' },
      wheel_layout: 'european',
      payouts: {
        straight: 36,
        split: 18,
        street: 12,
        corner: 9,
        six_line: 6,
        dozen: 3,
        column: 3,
        red: 2,
        black: 2,
        odd: 2,
        even: 2,
        low: 2,
        high: 2,
      },
      // (chip_sizes removed: dead key — the engine never reads it, and the
      // strict config schema rejects unknown keys; M-20-era it was advertised
      // to the UI but did nothing.)
    },
  },
  {
    slug: 'baccarat',
    displayName: 'Baccarat',
    category: ['card'],
    tags: [],
    sortOrder: 14,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 12,
    minBet: 10,
    configJson: {
      decks: 8,
      payouts: { player: 1.95, banker: 1.9, tie: 10.13 },
      banker_commission_percent: 5.0,
      drawing_rules: 'standard',
      natural_win: true,
    },
  },
  {
    slug: 'thimbles',
    displayName: 'Thimbles',
    category: ['casual'],
    tags: [],
    sortOrder: 15,
    baseRtp: 95.04,
    winRate: 48,
    maxWinMultiplier: 10,
    minBet: 10,
    configJson: {
      cups: 3,
      win_probability: 0.33,
      payout_multiplier: 2.88,
      difficulties: {
        easy: { swaps: 3, speed: 'slow' },
        medium: { swaps: 6, speed: 'medium' },
        hard: { swaps: 10, speed: 'fast' },
        impossible: { swaps: 14, speed: 'very_fast' },
      },
    },
  },
  {
    slug: 'ring-of-fortune',
    displayName: 'Ring of Fortune',
    category: ['casual'],
    tags: [],
    sortOrder: 16,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 60,
    minBet: 10, // The player BACKS A PRIZE TIER (previously no decision at all).
    configJson: {
      tiers: [
        { id: 'bronze', label: 'BRONZE', color: '#c98b4b', slices: 18 },
        { id: 'silver', label: 'SILVER', color: '#c7d0dd', slices: 9 },
        { id: 'gold', label: 'GOLD', color: '#f5c842', slices: 6 },
        { id: 'ruby', label: 'RUBY', color: '#ff3b5c', slices: 2 },
        { id: 'jackpot', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
      ],
    },
  },
  {
    slug: 'crash-x',
    displayName: 'CrashX',
    category: ['crash'],
    tags: [],
    sortOrder: 17,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 100,
    minBet: 10,
    configJson: {
      round_interval_ms: 4000,
      tick_interval_ms: 50,
      base_speed: 0.08,
      growth_rate: 0.0002,
      crash_distribution: {
        '1.00-1.10': 12.7,
        '1.10-1.50': 23.3,
        '1.50-2.00': 16.0,
        '2.00-3.00': 16.0,
        '3.00-5.00': 12.8,
        '5.00-10.00': 9.6,
        '10.00-25.00': 5.8,
        // C-04: tail folded into the 100× cap (same rationale as aviator).
        '25.00-100.00': 3.9,
      },
    },
  },
  {
    slug: 'stairs',
    displayName: 'Stairs',
    category: ['casual'],
    tags: [],
    sortOrder: 18,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 2000,
    minBet: 10, // NO payout_ladder: derived from choices_per_step / safe_per_step. The old one
    // flatlined at 100x from step 7 (fair: 122.88 / 245.76 / 491.52 / 983.04).
    configJson: { steps: 10, visual: 'stairs', choices_per_step: 2, safe_per_step: 1 },
  },
  {
    slug: 'scratch-card',
    displayName: 'Scratch Card',
    category: ['lottery'],
    tags: [],
    sortOrder: 19,
    baseRtp: 95,
    winRate: 48,
    maxWinMultiplier: 25,
    minBet: 10,
    configJson: {
      grid: { rows: 3, cols: 3 },
      symbols: [
        { symbol: '💰', weight: 30 },
        { symbol: '💎', weight: 25 },
        { symbol: '🎰', weight: 20 },
        { symbol: '🎲', weight: 15 },
        { symbol: '⭐', weight: 7 },
        { symbol: '🍀', weight: 3 },
      ],
      // Dead keys removed (win_rule, auto_reveal — engine never reads them).
      // win_combos recalibrated to the M-2 verified table: the previous table
      // simulated at ~636% RTP (casino pays ~6.4× stake per card — stop-ship).
      // This exact trio is what the engine falls back to when config is absent;
      // measured 96.47% over 400k rounds (see ScratchCardGame.startingPairOdds note).
      win_combos: [
        { symbol: '💰', count: 3, multiplier: 9.04 },
        { symbol: '💎', count: 3, multiplier: 4.52 },
        { symbol: '🎰', count: 3, multiplier: 2.71 },
      ],
    },
  },
  {
    slug: 'lucky-number',
    displayName: 'Lucky Number',
    category: ['lottery'],
    tags: [],
    sortOrder: 20,
    baseRtp: 95,
    winRate: 48,
    // 120, NOT 90: a single-number pick pays ~94.1x, so a ceiling of 90 would
    // silently clamp the fair payout back down (the exact bug that made this
    // game 49% RTP). Must stay in sync with migration 20260816160000.
    maxWinMultiplier: 120,
    minBet: 10,
    configJson: { min: 1, max: 100 },
  },
];

const LEGAL_PAGES = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'responsible-gaming', title: 'Responsible Gaming' },
  { slug: 'faq', title: 'FAQ' },
];

async function main() {
  // 1. Super admin (C-07: no hard-coded fallback password — in production the
  // seeder refuses to create one with guessable credentials).
  const WEAK_ADMIN_PASSWORDS = new Set([
    'change-this-immediately',
    'change-this-now',
    'admin',
    'password',
  ]);
  let adminPass = process.env.ADMIN_DEFAULT_PASSWORD;
  if (
    !adminPass ||
    (process.env.NODE_ENV === 'production' && WEAK_ADMIN_PASSWORDS.has(adminPass))
  ) {
    if (process.env.NODE_ENV === 'production')
      throw new Error(
        !adminPass
          ? 'ADMIN_DEFAULT_PASSWORD is not set — refusing to seed a super admin ' +
              'with fallback credentials in production.'
          : 'ADMIN_DEFAULT_PASSWORD is a known example value ("change-this-immediately" ' +
              'etc.) — refusing to seed a super admin with it in production. Set a strong one.'
      );
    // Non-production convenience: a random per-seed password keeps a local
    // DB useful without a guessable secret.
    adminPass = crypto.randomUUID();
    console.log('⚠ ADMIN_DEFAULT_PASSWORD unset — seeded a random one (dev only).');
  }
  // M-15: idempotent for a CUSTOM admin username. The old upsert always keyed
  // on 'superadmin': run twice with ADMIN_DEFAULT_USERNAME=boss and the second
  // run tried to CREATE 'boss' again → unique violation. Key on the effective
  // username, and support intentional password rotation via env.
  const adminUsername = process.env.ADMIN_DEFAULT_USERNAME || 'superadmin';
  const rotatePassword = process.env.ADMIN_ROTATE_PASSWORD === 'true';
  await prisma.adminUser.upsert({
    where: { username: adminUsername },
    create: {
      username: adminUsername,
      passwordHash: await bcrypt.hash(adminPass as string, 12),
      isSuperAdmin: true,
      displayName: 'Super Admin',
      permFinancial: true,
      permUsers: true,
      permReporting: true,
      permChat: true,
      permGames: true,
      permSettings: true,
    },
    // M-15: passwords never change silently — only when the operator opts in.
    update: rotatePassword
      ? { passwordHash: await bcrypt.hash(adminPass as string, 12) }
      : {},
  });
  if (rotatePassword)
    console.log('✓ Admin password rotated via ADMIN_ROTATE_PASSWORD=true');

  // 2. Settings (never overwrite existing)
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue },
      update: {},
    });
  }

  // 3. Games
  for (const game of GAMES) {
    const baseRtp = Number(game.baseRtp ?? 96);
    // D-072: demo mode enabled on every game — guests can try any game with
    // virtual coins (banner + reset built in), no login required.
    // D-089: configJson/odds are updated on re-seed (calibration fixes) —
    // the user's config changes must propagate, not just demoEnabled.
    const create = {
      ...game,
      houseEdge: +(100 - baseRtp).toFixed(2),
      demoEnabled: true,
    };
    const upd: Record<string, unknown> = {
      demoEnabled: true,
      configJson: game.configJson as never,
      baseRtp,
    };
    if (game.winRate !== undefined) upd.winRate = game.winRate;
    if (game.maxWinMultiplier !== undefined)
      upd.maxWinMultiplier = game.maxWinMultiplier;
    if (game.minBet !== undefined) upd.minBet = game.minBet;
    await prisma.gameConfig.upsert({
      where: { slug: game.slug as string },
      create: create as never,
      update: upd as never,
    });
  }

  // 3b. Validate every seeded game config (docs/06 — RTP ceiling in-request)
  // (validateConfig lives in src/services/gameConfig; imported lazily to keep seed standalone)
  // C-06: ALSO the per-game strict schema + exact per-choice RTP checks — the
  // generic winRate×avg-weight check never saw the tables games pay from.
  const { validateGameConfigJson } = await import('../src/engine/configValidation');
  for (const game of GAMES) {
    const check = validateGameConfigJson(
      game.slug as string,
      game.configJson,
      Number(game.maxWinMultiplier ?? Infinity)
    );
    if (!check.ok) {
      throw new Error(
        `Seed config for "${String(game.slug)}" fails strict validation: ` +
          check.issues.map((i) => `[${i.field}] ${i.message}`).join('; ')
      );
    }
  }

  // 4. Legal pages
  for (const page of LEGAL_PAGES) {
    await prisma.legalPage.upsert({
      where: { slug_language: { slug: page.slug, language: 'en' } },
      create: {
        ...page,
        language: 'en',
        content: `# ${page.title}\n\nPlaceholder content. Edit in admin panel.`,
      },
      update: {},
    });
  }

  // 5. Demo user (shared, no money — docs/20 §9 demo mode). The password is
  //    unusable (random), status ACTIVE so the demo middleware can attach it,
  //    and the seedPair hash MUST match the actual serverSeed (provably fair).
  const demoUser = await prisma.user.upsert({
    where: { phone: '+00000000000' },
    create: {
      phone: '+00000000000',
      passwordHash: await bcrypt.hash(crypto.randomUUID(), 12),
      displayName: 'Demo Player',
      status: 'ACTIVE',
      fingerprintHash: null,
    },
    update: {},
  });
  const demoServerSeed = crypto.randomBytes(32).toString('hex');
  await prisma.seedPair.upsert({
    where: { id: `demo-${demoUser.id}` },
    create: {
      id: `demo-${demoUser.id}`,
      userId: demoUser.id,
      serverSeed: demoServerSeed,
      serverSeedHash: crypto.createHash('sha256').update(demoServerSeed).digest('hex'),
      clientSeed: 'demo',
    },
    update: {},
  });
  // Zero-balance wallet so idempotent demo requests (duplicate requestId) can
  // snapshot without erroring — money is never moved for demo rounds.
  await prisma.wallet.upsert({
    where: { userId: demoUser.id },
    create: { userId: demoUser.id },
    update: {},
  });

  // 6. Manual payment accounts (D-061) — example accounts so the deposit flow
  //    works out of the box; edit/replace in Admin → Payment Accounts.
  // M-16: seeded INACTIVE and clearly labelled as examples. They shipped
  //    ACTIVE with placeholder numbers before — a fresh production deploy
  //    literally told players to send real money to 0301-2345678.
  const PAYMENT_ACCOUNTS = [
    {
      id: 'acc-jazzcash',
      type: 'mobile_wallet',
      label: 'JazzCash Wallet',
      details: {
        account_number: '0301 2345678',
        holder: 'YourBrand',
        bank: 'JazzCash',
      },
      order: 1,
    },
    {
      id: 'acc-easypaisa',
      type: 'mobile_wallet',
      label: 'Easypaisa',
      details: {
        account_number: '0345 9876543',
        holder: 'YourBrand',
        bank: 'Easypaisa',
      },
      order: 2,
    },
    {
      id: 'acc-bank',
      type: 'bank',
      label: 'Meezan Bank',
      details: {
        account_number: '0123-456789-01',
        holder: 'YourBrand Pvt Ltd',
        bank: 'Meezan Bank',
        iban: 'PK36 MEZN 0001 2345 6789 01',
      },
      order: 3,
    },
  ];
  for (const acc of PAYMENT_ACCOUNTS) {
    await prisma.manualPaymentAccount.upsert({
      where: { id: acc.id },
      create: {
        id: acc.id,
        type: acc.type,
        label: `[EXAMPLE] ${acc.label}`,
        accountDetails: acc.details as never,
        displayOrder: acc.order,
        isActive: false, // M-16: operator activates after entering real details
      },
      // Never clobber an operator's edits/activation on re-seed.
      update: {},
    });
  }

  console.log(
    'Seed complete ✅ (superadmin, settings, 20 games, legal pages, demo user, payment accounts)'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
