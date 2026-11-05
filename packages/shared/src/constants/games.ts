// packages/shared/src/constants/games.ts — the canonical 20-game registry (v3/v4 master prompt)
export const GAMES = [
  { slug: 'aviator', displayName: 'Aviator', category: ['crash', 'popular'] },
  { slug: 'plinko', displayName: 'Plinko', category: ['casual', 'popular'] },
  { slug: 'wingo', displayName: 'Win Go', category: ['lottery', 'popular'] },
  { slug: 'mines', displayName: 'Mines', category: ['casual', 'popular'] },
  { slug: 'dice', displayName: 'Dice', category: ['dice', 'provably-fair'] },
  { slug: 'wheel', displayName: 'Wheel of Fortune', category: ['casual'] },
  { slug: 'coin-flip', displayName: 'Coin Flip', category: ['casual'] },
  { slug: 'tower', displayName: 'Tower', category: ['casual'] },
  { slug: 'hi-lo', displayName: 'Hi-Lo', category: ['card'] },
  { slug: 'limbo', displayName: 'Limbo', category: ['dice', 'provably-fair'] },
  { slug: 'keno', displayName: 'Keno', category: ['lottery'] },
  { slug: 'dragon-tiger', displayName: 'Dragon Tiger', category: ['card'] },
  { slug: 'roulette', displayName: 'Roulette', category: ['table'] },
  { slug: 'baccarat', displayName: 'Baccarat', category: ['card'] },
  { slug: 'thimbles', displayName: 'Thimbles', category: ['casual'] },
  { slug: 'ring-of-fortune', displayName: 'Ring of Fortune', category: ['casual'] },
  { slug: 'crash-x', displayName: 'CrashX', category: ['crash'] },
  { slug: 'stairs', displayName: 'Stairs', category: ['casual'] },
  { slug: 'scratch-card', displayName: 'Scratch Card', category: ['lottery'] },
  { slug: 'lucky-number', displayName: 'Lucky Number', category: ['lottery'] },
] as const;

export type GameSlug = (typeof GAMES)[number]['slug'];

export const GAME_SLUGS: GameSlug[] = GAMES.map((g) => g.slug);

/** Lobby category pills (docs/16 §1) map onto registry categories. */
export const LOBBY_CATEGORIES = [
  'all',
  'popular',
  'new',
  'crash',
  'card',
  'dice',
  'table',
  'casual',
  'lottery',
  'provably-fair',
] as const;

/** Shared-round games (v3/v4 — house clock, Redis round state). */
export const SHARED_ROUND_GAMES: GameSlug[] = ['aviator', 'crash-x', 'wingo'];

/** Games with server-authoritative mid-round cashout. */
export const CASHOUT_GAMES: GameSlug[] = [
  'aviator',
  'crash-x',
  'mines',
  'tower',
  'stairs',
  'hi-lo',
];
