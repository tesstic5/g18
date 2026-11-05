// apps/api/src/routes/provably-fair.ts — seeds + round verification (v2 spec + v4)
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { PROVABLY_FAIR } from '@casino/game-core/provably-fair';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { AppError, ok } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { getNumericSetting } from '../services/settings';
import { verifyRoundRecord } from '../engine/verifyRound';

export async function provablyFairRoutes(app: FastifyInstance) {
  // GET /provably-fair/active-seed — hash only, NEVER the seed (rule 21)
  app.get('/active-seed', { preHandler: [authMiddleware] }, async (request) => {
    const seed = await prisma.seedPair.findFirstOrThrow({
      where: { userId: request.user!.id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    const rotation = await getNumericSetting('seed_rotation_after_rounds', 1000);
    return ok(
      {
        serverSeedHash: seed.serverSeedHash,
        clientSeed: seed.clientSeed,
        nonce: seed.nonce,
        roundsUntilRotation: Math.max(0, rotation - seed.nonce),
      },
      request.requestId!
    );
  });

  // POST /provably-fair/rotate-seed — atomic swap, reveal old (rule 10)
  app.post('/rotate-seed', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    // C-01: while ANY round is PENDING, the seed behind it must not become
    // verifiable — revealing it + /round/:id publishes every hidden outcome
    // (e.g. the full Mines board) and the player can then play a solved round.
    const pending = await prisma.gameRound.findFirst({
      where: { userId, result: 'PENDING' },
      select: { id: true },
    });
    if (pending)
      throw new AppError(
        ERROR_CODES.GAME_SEED_CHANGE_WITH_OPEN_ROUND,
        409,
        'Finish your active game before rotating seeds'
      );
    await prisma.$transaction(async (tx) => {
      await tx.seedPair.updateMany({
        where: { userId, status: 'ACTIVE' },
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
    return ok({ rotated: true }, request.requestId!);
  });

  // POST /provably-fair/change-client-seed
  app.post('/change-client-seed', { preHandler: [authMiddleware] }, async (request) => {
    const body = request.body as { newClientSeed: string };
    if (!body?.newClientSeed || body.newClientSeed.length > 128)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Invalid client seed');
    // C-01b: changing the client seed changes the committed outcomes of every
    // open round — refuse while any round is PENDING (same exploit class).
    const pending = await prisma.gameRound.findFirst({
      where: { userId: request.user!.id, result: 'PENDING' },
      select: { id: true },
    });
    if (pending)
      throw new AppError(
        ERROR_CODES.GAME_SEED_CHANGE_WITH_OPEN_ROUND,
        409,
        'Finish your active game before changing your client seed'
      );
    await prisma.seedPair.updateMany({
      where: { userId: request.user!.id, status: 'ACTIVE' },
      data: { clientSeed: body.newClientSeed },
    });
    return ok({ updated: true }, request.requestId!);
  });

  // GET /provably-fair/round/:id — full verification data (revealed seeds only)
  app.get('/round/:id', { preHandler: [authMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const round = await prisma.gameRound.findFirst({
      where: { id, userId: request.user!.id },
      include: { seedPair: true },
    });
    if (!round)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    const mapped = round.mappedOutcome as Record<string, unknown>;
    const special = (mapped.pf ?? null) as {
      algorithm?: string;
      serverSeed?: string;
      serverSeedHash?: string;
      clientSeed?: string;
      nonce?: number;
    } | null;
    if (!special?.serverSeed && round.seedPair.status !== 'REVEALED') {
      throw new AppError(
        ERROR_CODES.GAME_ROUND_NOT_FOUND,
        403,
        'Seed not yet revealed — rotate seeds first'
      );
    }
    // Belt & braces (C-01): never publish the full transcript of a round that
    // is still PENDING — its mappedOutcome contains hidden state (mines/traps)
    // that decides the still-live wager.
    if (round.result === 'PENDING')
      throw new AppError(
        ERROR_CODES.GAME_SEED_CHANGE_WITH_OPEN_ROUND,
        403,
        'Round is still in progress'
      );
    return ok(
      {
        roundId: round.id,
        gameSlug: round.gameSlug,
        algorithm: special?.algorithm ?? 'hmac-sha256-v1',
        serverSeed: special?.serverSeed ?? round.seedPair.serverSeed,
        serverSeedHash: special?.serverSeedHash ?? round.seedPair.serverSeedHash,
        clientSeed: special?.clientSeed ?? round.clientSeed,
        nonce: special?.nonce ?? round.nonce,
        rawOutcome: Number(round.rawOutcome),
        mappedOutcome: round.mappedOutcome,
        choices: round.choices,
        payoutMultiplier: Number(round.payoutMultiplier),
        payoutAmount: Number(round.payoutAmount),
        result: round.result,
        configSnapshotHash: round.configSnapshotHash,
        // Fairness disclosure: was this round decided by an operator control?
        // (force mode, and the difficulty that scaled the win chance.)
        forceUsed: round.forceUsed,
        difficulty:
          (round.configSnapshot as { difficulty?: unknown } | null)?.difficulty ??
          'normal',
        createdAt: round.createdAt,
      },
      request.requestId!
    );
  });

  // POST /provably-fair/verify — server-side check of a round (belt & braces)
  app.post('/verify', { preHandler: [authMiddleware] }, async (request) => {
    const { roundId } = request.body as { roundId: string };
    const round = await prisma.gameRound.findFirst({
      where: { id: roundId, userId: request.user!.id },
      include: { seedPair: true },
    });
    if (!round)
      throw new AppError(ERROR_CODES.GAME_ROUND_NOT_FOUND, 404, 'Round not found');
    const mapped = round.mappedOutcome as Record<string, unknown>;
    const special = (mapped.pf ?? null) as { serverSeed?: string } | null;
    if (!special?.serverSeed && round.seedPair.status !== 'REVEALED') {
      throw new AppError(
        ERROR_CODES.GAME_ROUND_NOT_FOUND,
        403,
        'Seed not yet revealed — rotate seeds first'
      );
    }
    const result = await verifyRoundRecord(round);
    return ok(
      {
        ...result,
        forceUsed: round.forceUsed,
        difficulty:
          (round.configSnapshot as { difficulty?: unknown } | null)?.difficulty ??
          'normal',
      },
      request.requestId!
    );
  });
}
