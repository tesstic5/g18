// Outcome searching is intentionally disabled.
//
// Searching later HMAC candidates until a desired verdict appears breaks the
// public seed transcript and catastrophically overpays player-priced choices.
// This fail-closed compatibility seam protects old callers and future slugs.
export function isSteerable(_slug: string): boolean {
  return false;
}
