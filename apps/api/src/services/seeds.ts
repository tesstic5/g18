import crypto from 'crypto';

import { prisma } from '../db/prisma';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';

/**
 * H-09 — automatic seed rotation.
 *
 * Before this service existed, a SeedPair was created once and REVEALED only
 * on explicit user action. One server seed therefore committed unbounded
 * rounds forever: a leaked/compromised seed would expose every historical
 * (and currently pending) outcome, and the "rotate to verify" ritual players
 * are told to rely on never actually happened.
 *
 * Policy: rotate a player's active pair once it has produced
 * AUTO_ROTATE_NONCE_THRESHOLD nonces (rounds). Rotation reveals the old
 * server seed (making every past round verifiable) and installs a fresh
 * committed pair — mirroring exactly what POST /provably-fair/rotate-seed
 * does, without requiring anyone to remember to click it.
 *
 * Rotation is scheduled fire-and-forget after a round settles; it never
 * blocks settlement. C-01 parity: it never runs while the user still has a
 * PENDING round, so the same invariant the rotate-seed route enforces holds
 * here (never make an open round's outcome verifiable mid-play).
 */
export const AUTO_ROTATE_NONCE_THRESHOLD = 100;

let lastRunByUser = new Map<string, number>();

/** Throttled per-user rotation; safe to call after every settled round. */
export function rotateSeedIfDue(userId: string, nonceNow: number): void {
  if (nonceNow % AUTO_ROTATE_NONCE_THRESHOLD !== 0) return;
  const now = Date.now();
  const last = lastRunByUser.get(userId) ?? 0;
  if (now - last < 60_000) return; // belt & braces vs. clustered settles
  lastRunByUser.set(userId, now);

  void (async () => {
    const open = await prisma.gameRound.findFirst({
      where: { userId, result: 'PENDING' },
      select: { id: true },
    });
    if (open) return;
    await prisma.$transaction(async (tx) => {
      const seedPair = await tx.seedPair.findFirst({
        where: { userId, status: 'ACTIVE' },
      });
      if (!seedPair) return; // C-01 made this vanish between checks — skip.
      if (seedPair.nonce < AUTO_ROTATE_NONCE_THRESHOLD) return; // re-check, raced
      await tx.seedPair.update({
        where: { id: seedPair.id },
        data: { status: 'REVEALED', revealedAt: new Date() },
      });
      const serverSeed = PROVABLY_FAIR.generateServerSeed();
      await tx.seedPair.create({
        data: {
          userId,
          serverSeed,
          serverSeedHash: PROVABLY_FAIR.hashServerSeed(serverSeed),
          clientSeed: crypto.randomBytes(8).toString('hex'),
        },
      });
    });
  })().catch((err) =>
    console.error('[seeds] auto-rotation failed for user', userId, err)
  );
}

/** Test seam: reset the in-memory throttle. */
export function __resetAutoRotationThrottle(): void {
  lastRunByUser = new Map();
}
