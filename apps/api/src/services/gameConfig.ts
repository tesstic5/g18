// apps/api/src/services/gameConfig.ts — cached config get with crash fallback,
// and validate-before-save (in the SAME request — docs/20 absolute rule 4).
import { GameConfig } from '../generated/prisma/client';
import crypto from 'crypto';
import Decimal from 'decimal.js';
import { prisma } from '../db/prisma';
import { redis, logRedisIssue } from '../db/redis';
import { validateConfig, type ValidationResult } from '@casino/shared';
import {
  validateGameConfigJson,
  patchTouchesOdds,
  usesGenericPayoutWeights,
} from '../engine/configValidation';
export { validateConfig };
export { validateGameConfigJson } from '../engine/configValidation';
export { patchTouchesOdds, usesGenericPayoutWeights } from '../engine/configValidation';
export type { ValidationResult };
import { AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';

const CACHE_TTL = 60; // seconds (docs/19 §13)

/**
 * Placeholder config used ONLY for read-only display when the DB is briefly
 * unreachable (lobby/detail rendering). `isActive: false` so it can never be
 * used to settle a bet with fabricated odds.
 *
 * Previously this was returned from getGameConfig() on ANY database error and
 * marked `isActive: true`, so a transient blip meant real money was settled
 * against invented winRate/maxWin values — and the round's configSnapshot
 * recorded those invented values as if they were real. It also used
 * `require('decimal.js')` inside an ESM package ("type": "module"), which
 * throws `require is not defined`, so the "safe" path crashed anyway.
 */
export function getSafeDefaultConfig(slug: string): GameConfig {
  return {
    slug,
    displayName: slug,
    description: null,
    thumbnailUrl: null,
    category: [],
    tags: [],
    sortOrder: 0,
    isActive: false,
    isFeatured: false,
    demoEnabled: false,
    baseRtp: new Decimal(94),
    winRate: new Decimal(45),
    houseEdge: new Decimal(6),
    maxWinMultiplier: new Decimal(10),
    minBet: new Decimal(1),
    defaultPayout: new Decimal(2),
    forceOverride: 'NONE',
    forceRoundsLeft: 0,
    forceMaxPayout: null,
    configJson: {},
    totalWagered: new Decimal(0),
    totalPaidOut: new Decimal(0),
    totalRounds: 0,
    effectiveRtp: null,
    animationSpeed: new Decimal(1),
    updatedAt: new Date(),
    updatedBy: null,
  } as unknown as GameConfig;
}

export async function getGameConfig(slug: string): Promise<GameConfig> {
  let cached: string | null = null;
  // Quietly skip the cache while Redis is still connecting (boot race).
  try {
    cached = await redis.get(`cache:game_config:${slug}`);
  } catch (e) {
    logRedisIssue('gameConfig', e);
  }
  if (cached) return JSON.parse(cached) as GameConfig;
  try {
    const config = await prisma.gameConfig.findUnique({ where: { slug } });
    if (!config) throw new AppError(ERROR_CODES.GAME_NOT_FOUND, 404, 'Game not found');
    if (!config.isActive)
      throw new AppError(ERROR_CODES.GAME_NOT_ACTIVE, 403, 'Game is not active');
    try {
      await redis.set(
        `cache:game_config:${slug}`,
        JSON.stringify(config),
        'EX',
        CACHE_TTL
      );
    } catch {
      /* best effort */
    }
    return config;
  } catch (e) {
    if (e instanceof AppError) throw e;
    // The DB is unreachable. NEVER invent odds and settle real money against
    // them — surface a retryable 503 instead. (Was: return a fabricated
    // "safe default" config, which silently changed the game's economics.)
    console.error(`[gameConfig] load failed for "${slug}":`, (e as Error).message);
    throw new AppError(
      'SVC_503',
      503,
      'Game is temporarily unavailable — please try again in a moment.'
    );
  }
}

/** sha256 of canonical JSON — stored per round as configSnapshotHash (docs/05 §3). */
export function snapshotHash(config: GameConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(config)))
    .digest('hex');
}

export function canonicalize(config: GameConfig): Record<string, unknown> {
  const { updatedAt, totalWagered, totalPaidOut, effectiveRtp, ...rest } =
    config as unknown as Record<string, unknown>;
  // H-03: deep-sort keys — Postgres jsonb reorders object keys on read-back,
  // so an insertion-ordered serialization can never re-hash match. A sorted
  // canonical form makes configSnapshotHash order-independent and therefore
  // verifiable from the STORED snapshot alone.
  return deepSort(rest) as Record<string, unknown>;
}

/** Recursively sort object keys (arrays keep their order — they are positional). */
export function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = deepSort((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Save config — validation runs synchronously in this same request. Returns 422 on invalid. */
export async function saveGameConfig(
  slug: string,
  patch: Record<string, unknown>,
  adminId: string
): Promise<GameConfig> {
  const current = await prisma.gameConfig.findUniqueOrThrow({ where: { slug } });
  const merged = { ...(current as unknown as Record<string, unknown>), ...patch };

  // Hide / Hot / rename must never 422 because leftover odds fail the generic
  // RTP ceiling. Aviator's seeded payout_weights compute ~213% RTP and are
  // not even read by the crash engine — they blocked every isActive toggle.
  if (patchTouchesOdds(patch)) {
    if (usesGenericPayoutWeights(slug)) {
      const weights = (
        merged.configJson as {
          payout_weights?: Array<{ multiplier: number; weight: number }>;
        }
      )?.payout_weights ?? [{ multiplier: Number(merged.defaultPayout), weight: 1 }];
      const result = validateConfig({
        winRate: Number(merged.winRate),
        payoutWeights: weights,
        maxWinMultiplier: Number(merged.maxWinMultiplier),
      });
      if (!result.valid)
        throw new AppError(ERROR_CODES.CONF_EXCEEDS_CEILING, 422, result.error!, {
          calculatedRtp: result.calculatedRtp,
        });
    }

    // C-06: per-game STRICT schema + exact per-choice RTP/liability validation.
    // The generic winRate×avg-weight check above never reads the config keys the
    // game handler actually pays from (payouts, payout_tables, risk_levels…), so
    // it alone let catastrophic configs through.
    const strict = validateGameConfigJson(
      slug,
      merged.configJson,
      Number(merged.maxWinMultiplier)
    );
    if (!strict.ok) {
      const first = strict.issues[0]!;
      throw new AppError(
        ERROR_CODES.CONF_EXCEEDS_CEILING,
        422,
        `${slug}: ${strict.issues.length} config problem(s) — first: [${first.field}] ${first.message}`,
        { issues: strict.issues }
      );
    }
  }

  const saved = await prisma.gameConfig.update({
    where: { slug },
    data: { ...patch, updatedBy: adminId } as never,
  });
  // v1.4.0: bust BOTH caches — game_config AND the 30s lobby. Before this a
  // hidden game lingered in the lobby for up to 30 seconds (players could
  // open it and be 403'd mid-click), and hot-tag/order changes showed late.
  await redis.del(`cache:game_config:${slug}`, 'cache:lobby');
  return saved;
}
