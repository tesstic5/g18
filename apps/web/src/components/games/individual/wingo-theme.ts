// apps/web/src/components/games/individual/wingo-theme.ts
// Design tokens for the WinGo screen, matched to the reference build
// (light "PAK Games" styling: salmon/red header, white cards, soft grey page).
//
// Kept separate from wingo-core.ts (pure game rules) so the visual language can
// be tuned without touching payout/statistics logic.

export const WG = {
  /** page + surfaces */
  pageBg: '#f2f3f7',
  card: '#ffffff',
  cardBorder: '#eceef3',
  headerFrom: '#fb7d130', // unused placeholder guard
  /** brand red used by the header bar and primary actions */
  red: '#f4513d',
  redDark: '#e8402c',
  redSoft: '#fd8a78',
  /** the salmon → red gradient of the top app bar */
  headerGrad: 'linear-gradient(180deg,#fb8f7d 0%,#f4513d 100%)',
  /** period / countdown banner gradient */
  bannerGrad: 'linear-gradient(135deg,#f8705c 0%,#f4513d 55%,#ef4331 100%)',
  /** ball + chip colors */
  green: '#22b573',
  greenDark: '#16965c',
  redBall: '#f0453a',
  violet: '#c94fd6',
  /** Big / Small pills */
  big: '#f0a63c',
  small: '#4c9bd8',
  /** text */
  text: '#2b2f3a',
  textMuted: '#8a90a0',
  textFaint: '#c3c7d2',
  /** table */
  rowBorder: '#f0f1f5',
} as const;

/**
 * Real WinGo ball colouring. 0 and 5 are DUAL-colour balls
 * (0 = red+violet, 5 = green+violet), everything else is a solid colour.
 * The trend/statistics dots use the single dominant colour from wingo-core.
 */
export function ballGradient(n: number): string {
  if (n === 0)
    return `linear-gradient(135deg, ${WG.redBall} 0%, ${WG.redBall} 50%, ${WG.violet} 50%, ${WG.violet} 100%)`;
  if (n === 5)
    return `linear-gradient(135deg, ${WG.green} 0%, ${WG.green} 50%, ${WG.violet} 50%, ${WG.violet} 100%)`;
  return n % 2 === 1
    ? `linear-gradient(180deg, #35c684 0%, ${WG.green} 100%)`
    : `linear-gradient(180deg, #f75f4f 0%, ${WG.redBall} 100%)`;
}

/** Solid dot colour for the trend grid / history rows. */
export function dotColor(n: number): string {
  if (n === 0 || n === 5) return WG.violet;
  return n % 2 === 1 ? WG.green : WG.redBall;
}

/** Big (5-9) vs Small (0-4) badge shown at the right of each history row. */
export function sizeBadge(n: number): { label: 'B' | 'S'; color: string } {
  return n >= 5 ? { label: 'B', color: WG.big } : { label: 'S', color: WG.small };
}
