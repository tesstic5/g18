// packages/shared/src/types/index.ts — shared domain types
import type { GameSlug } from '../constants/games';

export type { GameSlug };

export type WalletType = 'REAL' | 'BONUS' | 'GIFTED' | 'LOCKED';

/** Settled outcomes shown to the player (no in-flight PENDING). */
export const SETTLED_ROUND_RESULTS = [
  'WIN',
  'LOSE',
  'CASHOUT',
  'BUST',
  'PUSH',
] as const;
export type SettledRoundResult = (typeof SETTLED_ROUND_RESULTS)[number];

/**
 * Canonical round result — matches Prisma `RoundResult`.
 * PENDING is session/shared-round in-flight only; never a banner verdict.
 */
export const ROUND_RESULTS = [...SETTLED_ROUND_RESULTS, 'PENDING'] as const;
export type RoundResult = (typeof ROUND_RESULTS)[number];

export type ForceOverride = 'NONE' | 'FORCE_WIN' | 'FORCE_LOSE';

/** Bet request body (docs/19 §7). */
export interface BetRequestPayload {
  amount: number; // max 2 decimals
  walletType?: WalletType | 'AUTO';
  choices: Record<string, unknown>;
  clientSeed: string;
  requestId?: string;
}

/** Bet response (docs/19 §7 4a). */
export interface BetResultPayload {
  roundId: string;
  result: SettledRoundResult;
  rawOutcome: number;
  mappedOutcome: unknown; // animation_data — client animates exactly this
  payoutMultiplier: number;
  payoutAmount: number;
  newBalance: { real: number; bonus: number; gifted: number; locked: number };
  seedHash: string;
  nonce: number;
  animationData?: unknown; // alias of mappedOutcome for shared components
}

/** Wallet snapshot (server truth, strings for decimal safety). */
export interface WalletSnapshot {
  real: string;
  bonus: string;
  gifted: string;
  locked: string;
}

/** User-facing config for a game (rules modal, lobby). */
export interface PublicGameConfig {
  slug: GameSlug;
  displayName: string;
  description?: string | null;
  thumbnailUrl?: string | null;
  category: string[];
  tags: string[];
  isActive: boolean;
  demoEnabled: boolean;
  baseRtp: number;
  minBet: number;
  maxWinMultiplier: number;
  animationSpeed: number;
  configJson: Record<string, unknown>;
}

/** Per-game deliverable contract (docs/21): BetChoices / MappedOutcome / GameConfig. */
// Each game in packages/shared/src/types/games/{game}.types.ts implements these;
// generic fallback types below keep cross-game code type-safe.

export interface GameTypes {
  choices: Record<string, unknown>;
  mappedOutcome: Record<string, unknown>;
  configJson: Record<string, unknown>;
}
