import { z } from 'zod';
import { SETTLED_ROUND_RESULTS } from '@casino/shared/types';

export const finiteNumber = z
  .union([z.number(), z.string().trim().min(1)])
  .transform((value, ctx) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      ctx.addIssue({ code: 'custom', message: 'Expected a finite numeric value' });
      return z.NEVER;
    }
    return number;
  });

export const balanceDto = z.object({
  real: finiteNumber,
  bonus: finiteNumber,
  gifted: finiteNumber,
  locked: finiteNumber,
  // M-11: server-configured bet spend order for the optimistic deduction
  spendPriority: z.array(z.enum(['REAL', 'BONUS', 'GIFTED'])).optional(),
});

/** POST /auth/login + /auth/signup — the session the store trusts with money. */
export const authSessionDto = z.object({
  accessToken: z.string().min(10),
  csrfToken: z.string().min(16).optional(),
  // Present on signup only. false = the player arrived with an invite code we
  // could not match; they are registered anyway. (Zod strips unknown keys, so
  // without this the field would never reach the UI.)
  referralApplied: z.boolean().optional(),
  user: z.object({
    id: z.string().min(1),
    phone: z.string(),
    displayName: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
  }),
});
export type AuthSession = z.infer<typeof authSessionDto>;

/** GET /wallet/transactions — money history rows (tolerant field set). */
export const txnDto = z
  .object({
    id: z.string(),
    type: z.string(),
    amount: z.union([finiteNumber, z.string()]),
    balanceAfter: z.union([finiteNumber, z.string()]).nullish(),
    status: z.string().nullish(),
    createdAt: z.string(),
    description: z.string().nullish(),
  })
  .passthrough();
export const txnListDto = z.object({ data: z.array(txnDto) });

export const gameDetailDto = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  baseRtp: finiteNumber,
  minBet: finiteNumber,
  maxBet: finiteNumber.optional(),
  maxWinMultiplier: finiteNumber,
  configJson: z.record(z.string(), z.unknown()).optional(),
  demoEnabled: z.boolean().optional(),
  roundDurationSec: finiteNumber.optional(),
});

export const adminGameDto = z.object({
  slug: z.string(),
  displayName: z.string(),
  isActive: z.boolean().optional(),
  baseRtp: finiteNumber,
  winRate: finiteNumber,
  maxWinMultiplier: finiteNumber,
  configJson: z.record(z.string(), z.unknown()),
  totalRounds: z.number(),
  totalWagered: finiteNumber,
  totalPaidOut: finiteNumber,
  effectiveRtp: finiteNumber.nullable(),
  forceOverride: z.enum(['NONE', 'FORCE_WIN', 'FORCE_LOSE']).optional(),
  forceRoundsLeft: z.number().optional(),
  forceMaxPayout: finiteNumber.nullable().optional(),
  outcomeOverridesEnabled: z.boolean().optional(),
  difficultyCapable: z.boolean().optional(),
  difficulty: z.enum(['easy', 'normal', 'hard', 'impossible']).nullable().optional(),
});

export const withdrawalFeeDto = z.object({
  percent: finiteNumber,
  fee: finiteNumber,
  net: finiteNumber,
});

export function parseDto<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} response was invalid`);
  }
  return parsed.data;
}

// ── Shared, uniform response contracts (docs/19 §21) ───────────────────────
// One schema per consumed endpoint. Every parse failure becomes a readable
// ApiError at the transport layer instead of a silent `.toFixed()` crash
// three components later.

const roundResultDto = z.enum(SETTLED_ROUND_RESULTS);

/** POST /games/:slug/bet — instant + shared-round responses (docs/19 §7). */
export const betRoundDto = z.object({
  roundId: z.string(),
  // Shared-round games (aviator / crash-x) answer `{status:'PLACED'}` with
  // NO result yet — the round settles later via socket ({slug}:my-result).
  // Marking result/payoutAmount required made such bets throw GEN_DTO at the
  // transport layer every single time: the server had accepted the bet, the
  // wallet was debited, and the button snapped back to BET with an unrelated
  // "unexpected response" toast. They are only absent on shared-round accepts.
  result: roundResultDto.optional(),
  payoutAmount: finiteNumber.optional(),
  payoutMultiplier: finiteNumber.optional(),
  newBalance: balanceDto.optional(),
  mappedOutcome: z.record(z.string(), z.unknown()).nullable().optional(),
  nonce: z.number().optional(),
  seedHash: z.string().optional(),
  status: z.enum(['PLACED', 'SKIPPED']).optional(),
  // crash placement ack — the multiplier at which this bet JOINED the flight
  // (1 for a clean take-off; >1 for mid-flight join — prices the payout).
  joinMultiplier: finiteNumber.optional(),
});

/** GET /games/bet-status — timeout recovery (docs/19 §7 4c). */
export const betStatusDto = z
  .object({
    round: z.object({
      roundId: z.string(),
      result: roundResultDto,
      payoutAmount: finiteNumber,
      payoutMultiplier: finiteNumber,
      mappedOutcome: z.record(z.string(), z.unknown()),
      nonce: z.number(),
      seedHash: z.string(),
      newBalance: balanceDto,
    }),
  })
  .nullable();

/** Session games (D-092): shared view shape for start/step/recover. */
export const sessionViewDto = z.object({
  roundId: z.string(),
  slug: z.string(),
  betAmount: z.union([z.string(), z.number().transform(String)]),
  status: z.enum(['ACTIVE', 'CASHOUT', 'BUST']),
  stepIndex: z.number(),
  currentMultiplier: finiteNumber,
  nextMultiplier: finiteNumber,
  steps: z.array(z.unknown()),
  extra: z.record(z.string(), z.unknown()),
});
export type SessionViewT = z.infer<typeof sessionViewDto>;

export const sessionStartDto = z.object({
  status: z.literal('SESSION_STARTED'),
  session: sessionViewDto,
});

export const sessionRecoverDto = z.object({
  status: z.enum(['SESSION_ACTIVE', 'NO_SESSION']),
  session: sessionViewDto.nullable(),
});

export const sessionStepDto = z.object({
  view: sessionViewDto,
  stepResult: z.record(z.string(), z.unknown()),
  terminal: z.boolean(),
});

export const sessionCashoutDto = z.object({
  roundId: z.string(),
  result: z.literal('CASHOUT'),
  multiplier: finiteNumber,
  payout: z.union([z.string(), z.number().transform(String)]),
  mappedOutcome: z.record(z.string(), z.unknown()),
});

/** Lobby list (GET /games). */
export const lobbyGameDto = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  category: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  demoEnabled: z.boolean().optional(),
  baseRtp: finiteNumber.optional(),
  minBet: finiteNumber.optional(),
  animationSpeed: finiteNumber.optional(),
});
export const lobbyListDto = z.array(lobbyGameDto);

/** GET /games/lobby-ui — public lobby chrome flags. */
export const lobbyUiDto = z.object({
  showGameNames: z.boolean(),
});

/** GET /provably-fair/active-seed. */
export const activeSeedDto = z.object({
  clientSeed: z.string(),
  nonce: z.number(),
  serverSeedHash: z.string().optional(),
});

/** WinGo live round snapshot (GET /games/wingo/rounds). */
export const wingoRoundSnapshotDto = z.object({
  roundId: z.string(),
  period: z.string(),
  durationSec: finiteNumber,
  status: z.string(),
  endsAt: finiteNumber,
  bettingOpen: z.boolean(),
  remainingSec: finiteNumber,
  serverSeedHash: z.string(),
  payouts: z.record(z.string(), finiteNumber).optional(),
  maxWinMultiplier: finiteNumber.nullish(),
});
export const wingoRoundsDto = z.array(wingoRoundSnapshotDto);

/** WinGo history rows (recent + history-list). */
export const wingoHistoryEntryDto = z.object({
  number: finiteNumber,
  color: z.string(),
  period: z.string(),
  at: finiteNumber.optional(),
});
export const wingoHistoryDto = z.array(wingoHistoryEntryDto);
export const wingoHistoryListDto = z.object({
  data: z.array(wingoHistoryEntryDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  pages: z.number(),
});

/** Aviator/Crash-X join+refresh snapshot (GET /games/:slug/crash-state). */
export const crashStateDto = z.object({
  slug: z.string(),
  round: z
    .object({
      roundId: z.string(),
      status: z.enum(['countdown', 'flying', 'crashed']),
      multiplier: z.number(),
      crashPoint: z.number().optional(),
      serverSeedHash: z.string().optional(),
    })
    .nullable(),
  myLive: z
    .object({
      roundId: z.string(),
      amount: z.string(),
      joinMultiplier: z.number(),
      status: z.string(),
    })
    .nullable(),
  recent: z.array(z.number()),
});
export type CrashState = z.infer<typeof crashStateDto>;

/** Per-game round history (GET /games/:slug/history). */
export const gameHistoryRowDto = z.object({
  id: z.string(),
  betAmount: z.union([z.string(), z.number()]),
  result: roundResultDto.or(z.string()),
  payoutMultiplier: z.union([z.string(), z.number()]),
  payoutAmount: z.union([z.string(), z.number()]),
  createdAt: z.string(),
  mappedOutcome: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const gameHistoryDto = z.object({
  data: z.array(gameHistoryRowDto),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    totalPages: z.number(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  }),
});
