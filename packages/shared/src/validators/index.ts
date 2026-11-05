// packages/shared/src/validators/index.ts — zod schemas shared FE+BE (docs/14, docs/19 §7)
import { z } from 'zod';
import Decimal from 'decimal.js';
import { LIMITS } from '../constants/limits';
import { GAME_SLUGS } from '../constants/games';

// D-083: loose input schema — users may type 0300 1234567, +92 300 1234567,
// 923001234567, 3001234567, with spaces/dashes. The API normalizes to the
// canonical +92XXXXXXXXXX form (utils/phone.normalizePhone) and validates the
// RESULT, so the raw format never causes a confusing rejection.
export const phoneSchema = z
  .string()
  .trim()
  .min(4, 'Enter your mobile number')
  .max(30, 'Phone number too long')
  .refine((v) => !v.includes('@') && /[0-9]/.test(v), 'Enter a valid mobile number');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72);

export const displayNameSchema = z
  .string()
  .trim()
  .max(24, 'Display name max 24 characters')
  .regex(/^[a-zA-Z0-9 ]*$/, 'Alphanumeric + spaces only')
  .optional()
  .or(z.literal(''));

export const amountSchema = z
  .number({ error: 'Amount must be a number' })
  .positive('Amount must be positive')
  .finite()
  .max(LIMITS.MAX_BET_AMOUNT)
  // Decimal-based check. `Number.isInteger(v * 100)` looked correct but failed
  // on ordinary values because of binary floating point: 1.1 * 100 is
  // 110.00000000000001, 0.29 * 100 is 28.999999999999996 — so ₨1.10 and ₨0.29
  // bets/deposits were rejected with "Max 2 decimal places".
  .refine(
    (v) => new Decimal(v).decimalPlaces() <= LIMITS.MAX_MONEY_DECIMALS,
    'Max 2 decimal places'
  );

export const walletTypeSchema = z.enum(['REAL', 'BONUS', 'GIFTED', 'LOCKED', 'AUTO']);

export const betRequestSchema = z.object({
  amount: amountSchema,
  walletType: walletTypeSchema.default('AUTO'),
  choices: z.record(z.string(), z.unknown()).default({}),
  clientSeed: z.string().min(1).max(128),
  requestId: z.string().uuid().optional(),
});

export const signupSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  fingerprint: z.object({
    userAgent: z.string().max(512),
    screenRes: z.string().max(32),
    timezone: z.string().max(64),
    language: z.string().max(32),
  }),
  referralCode: z.string().max(32).optional(),
});

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
  fingerprint: z.object({
    userAgent: z.string().max(512),
    screenRes: z.string().max(32),
    timezone: z.string().max(64),
    language: z.string().max(32),
  }),
});

export const depositCreateSchema = z.object({
  amount: amountSchema,
  /** Optional top-up package the player picked on the deposit page. */
  packageId: z.string().min(1).max(64).optional(),
  paymentMethod: z.string().min(1).max(64),
  accountLabel: z.string().max(128).optional(),
  // upgrade (D-061): the selected payment account's details snapshot + the
  // sender's account number the user paid FROM (confirmation reference)
  accountDetails: z.record(z.string(), z.unknown()).optional(),
  senderAccount: z.string().max(64).optional(),
  // H-07: the proof reference is REQUIRED — a manual deposit without a
  // receipt object is an unreviewable debt claim.
  proofObjectKey: z.string().min(8).max(255),
});

export const withdrawalCreateSchema = z.object({
  amount: amountSchema,
  payoutAccountId: z.string().min(1).max(64),
});

export const payoutAccountSchema = z.object({
  // MUST stay in sync with the server's accepted list in
  // apps/api/src/routes/withdrawals.ts. 'crypto' was listed here but rejected
  // by the route (422), and the route's 'mobile_wallet' — what the web client
  // actually sends — was missing from this enum.
  type: z.enum(['bank', 'mobile_wallet', 'mobile_money']),
  label: z.string().min(1).max(64),
  details: z
    .record(z.string(), z.string())
    .refine((o) => Object.keys(o).length > 0, 'Details required'),
});

export const gameSlugSchema = z.enum(GAME_SLUGS as unknown as [string, ...string[]]);

export const changeClientSeedSchema = z.object({
  newClientSeed: z.string().min(1).max(128),
});

export const responsiblePlaySchema = z.object({
  dailyLossLimit: z.number().nonnegative().nullable().optional(),
  dailyDepositLimit: z.number().nonnegative().nullable().optional(),
  sessionReminderMin: z.number().int().min(0).max(480).nullable().optional(),
  selfExclusionHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullable()
    .optional(), // null = cancel; >8760 = permanent sentinel
});

export const giftSendSchema = z.object({
  recipientPhone: phoneSchema,
  amount: amountSchema,
  message: z.string().max(200).optional(),
});
