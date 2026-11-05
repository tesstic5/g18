// apps/api/src/routes/recovery.ts — PUBLIC account-recovery surface.
//
// This is the only part of the platform reachable by someone who cannot log
// in, which is why it is deliberately thin, rate-limited, and says as little
// as possible:
//
//   POST /request  — file a recovery request, get a TICKET code back
//   POST /status   — read the thread + collect the recovery code (needs ticket)
//   POST /message  — reply to the agent (needs ticket)
//   POST /redeem   — set a new password with the one-time recovery code
//
// No email, no SMS: the ticket code is the delivery channel, and it is the
// claimant who keeps it. Neither endpoint ever confirms whether a phone number
// has an account — every request is accepted and answered identically.
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { passwordSchema, phoneSchema } from '@casino/shared/validators';
import { checkPassword } from '../services/securityPolicy';
import { normalizePhone } from '@casino/shared/utils/phone';
import { maskPhone } from '@casino/game-core/mask';
import { ok, AppError } from '../lib/core';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { decryptJson } from '../lib/crypto-utils';
import { prisma } from '../db/prisma';
import { rateLimit } from '../middleware';
import { getNumericSetting } from '../services/settings';
import { raiseFraudSignal } from '../services/fraud';
import { notifyUser } from '../services/notify';
import {
  isPasswordReused,
  loadPasswordPolicy,
  recordPasswordHistory,
  revokeAllSessions,
} from '../services/auth';
import {
  RECOVERY_MAX_ATTEMPTS,
  attemptsExhausted,
  freezeActive,
  freezeMessage,
  generateCode,
  hashCode,
  hashesEqual,
  redeemGuard,
  statusLabel,
  threadOpen,
  type RecoveryStatus,
} from '../services/recovery';

/** How many messages the ticket page returns. */
const THREAD_LIMIT = 50;
/** Free-text cap for a public message. */
const MAX_MESSAGE = 2000;

const requestSchema = z.object({
  phone: phoneSchema,
  message: z.string().trim().max(MAX_MESSAGE).optional(),
  answers: z
    .object({
      lastDepositRef: z.string().trim().max(64).optional(),
      senderAccount: z.string().trim().max(64).optional(),
      payoutHint: z.string().trim().max(64).optional(),
      signupHint: z.string().trim().max(120).optional(),
    })
    .optional(),
});

const ticketSchema = z.object({ ticket: z.string().trim().min(8).max(64) });

const messageSchema = ticketSchema.extend({
  body: z.string().trim().min(1).max(MAX_MESSAGE),
});

const redeemSchema = ticketSchema.extend({
  code: z.string().trim().min(8).max(64),
  newPassword: passwordSchema,
});

interface PublicThreadEntry {
  from: 'PLAYER' | 'SUPPORT';
  body: string;
  at: string;
}

/**
 * Requests whose number is not on file have no support conversation to attach
 * to (SupportConversation.userId is a required FK), so those claimant messages
 * are kept in the request's JSON answers instead. Both paths are returned by
 * /status in the same shape — that is what keeps the flow indistinguishable
 * for a registered and an unregistered number.
 */
function jsonAnswers(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function storedThread(answers: unknown): PublicThreadEntry[] {
  const raw = jsonAnswers(answers)['thread'];
  if (!Array.isArray(raw)) return [];
  const out: PublicThreadEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const body = typeof e.body === 'string' ? e.body : '';
    const at = typeof e.at === 'string' ? e.at : new Date().toISOString();
    const from = e.from === 'SUPPORT' ? 'SUPPORT' : 'PLAYER';
    if (body) out.push({ from, body, at });
  }
  return out;
}

/** Append one claimant message to the JSON thread (unmatched-number path). */
function withThreadMessage(
  answers: unknown,
  entry: PublicThreadEntry
): Record<string, unknown> {
  const base = jsonAnswers(answers);
  const thread = [...storedThread(answers), entry].slice(-THREAD_LIMIT);
  return { ...base, thread };
}

async function findRequest(ticket: string) {
  return prisma.recoveryRequest.findUnique({
    where: { ticketHash: hashCode(ticket) },
  });
}

export default async function recoveryRoutes(app: FastifyInstance) {
  // ── POST /recovery/request ───────────────────────────────────────────────
  app.post('/request', async (request) => {
    await rateLimit(request, 'recoveryRequest', request.ip);
    const parsed = requestSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'Check the form and try again'
      );

    const phone = normalizePhone(parsed.data.phone);
    if (!phone)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        'Enter a valid mobile number (for example 0300 1234567)'
      );

    const answers = parsed.data.answers ?? undefined;
    const message = parsed.data.message;
    const ip = request.ip;
    const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 400) || null;

    // Deliberately NOT `findUniqueOrThrow`: an unknown number is a real case,
    // not an error. It is kept so operators can see the pattern and so the
    // public response never depends on whether the account exists.
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, displayName: true },
    });

    const ticket = generateCode('ticket');
    const ticketHash = hashCode(ticket);

    const firstMessage = [
      message ? message : 'I cannot log in to my account.',
      answers?.lastDepositRef ? `Last deposit reference: ${answers.lastDepositRef}` : '',
      answers?.senderAccount ? `Sender account: ${answers.senderAccount}` : '',
      answers?.payoutHint ? `Payout account: ${answers.payoutHint}` : '',
      answers?.signupHint ? `Signup detail: ${answers.signupHint}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const created = await prisma.$transaction(async (tx) => {
      let conversationId: string | null = null;
      if (user) {
        const convo = await tx.supportConversation.create({
          data: {
            userId: user.id,
            subject: 'Account recovery request',
            category: 'account_recovery',
            playerLastReadAt: new Date(),
          },
        });
        conversationId = convo.id;
        await tx.supportMessage.create({
          data: {
            conversationId: convo.id,
            senderType: 'USER',
            userId: user.id,
            body: firstMessage,
          },
        });
      }
      return tx.recoveryRequest.create({
        data: {
          userId: user?.id ?? null,
          phoneClaimed: phone,
          answers: (answers ?? null) as never,
          conversationId,
          ticketHash,
          ip,
          userAgent,
        },
      });
    });

    if (user) {
      await raiseFraudSignal(
        user.id,
        'ACCOUNT_RECOVERY_REQUEST',
        'medium',
        {
          notes: 'Player filed a recovery request from the public lockout form',
          requestId: created.id,
          hasAnswers: Boolean(answers),
          ip,
        },
        { dedupe: true }
      );
    }
    emitAdmin('recovery-request', {
      id: shortId(created.id),
      userId: user ? shortId(user.id) : null,
      phone: maskPhone(phone),
      at: Date.now(),
    });

    // The ticket code is shown ONCE. Only its hash is stored, so it can never
    // be re-read out of the database — not even by an operator.
    return ok(
      {
        ticket,
        status: created.status,
        statusLabel: statusLabel(created.status),
        createdAt: created.createdAt.toISOString(),
      },
      request.requestId!
    );
  });

  // ── POST /recovery/status ────────────────────────────────────────────────
  app.post('/status', async (request) => {
    await rateLimit(request, 'recoveryCheck', request.ip);
    const parsed = ticketSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Enter your ticket code');
    const found = await findRequest(parsed.data.ticket);
    if (!found)
      throw new AppError(
        ERROR_CODES.GEN_NOT_FOUND,
        404,
        'No recovery request matches that code — check the code, or file a new request'
      );

    const now = Date.now();
    let status: RecoveryStatus = found.status as RecoveryStatus;
    let code: string | null = null;
    let codeExpiresAt = found.codeExpiresAt;

    // Lazy expiry: a code nobody collected must not linger as redeemable.
    if (
      status === 'APPROVED' &&
      (!found.codeExpiresAt ||
        found.codeExpiresAt.getTime() <= now ||
        attemptsExhausted(found.attempts))
    ) {
      const expired = await prisma.recoveryRequest.update({
        where: { id: found.id },
        data: { status: 'EXPIRED', codeHash: null, codeEncrypted: null, codeExpiresAt: null },
      });
      status = expired.status as RecoveryStatus;
      codeExpiresAt = null;
    } else if (status === 'APPROVED' && found.codeEncrypted) {
      try {
        code = decryptJson<{ code: string }>(found.codeEncrypted).code;
      } catch {
        // Unreadable ciphertext (rotated key) — treat as no code rather than
        // handing the player a broken challenge; an admin re-issues.
        code = null;
      }
    }

    const stored = storedThread(found.answers);
    let messages: PublicThreadEntry[] = stored;
    if (found.conversationId) {
      // Newest THREAD_LIMIT rows, then restored to chronological order.
      const rows = await prisma.supportMessage.findMany({
        where: { conversationId: found.conversationId },
        orderBy: { createdAt: 'desc' },
        take: THREAD_LIMIT,
        select: { id: true, senderType: true, body: true, createdAt: true },
      });
      messages = rows
        .slice()
        .reverse()
        .map((m) => ({
          from: m.senderType === 'ADMIN' ? ('SUPPORT' as const) : ('PLAYER' as const),
          body: m.body,
          at: m.createdAt.toISOString(),
        }));
    }

    // Opening the ticket page counts as reading the thread.
    if (found.conversationId) {
      await prisma.supportConversation.update({
        where: { id: found.conversationId },
        data: { playerLastReadAt: new Date() },
      });
    }

    const frozen = freezeActive(found.freezeUntil, now);
    return ok(
      {
        status,
        statusLabel: statusLabel(status),
        createdAt: found.createdAt.toISOString(),
        updatedAt: found.updatedAt.toISOString(),
        messages,
        code,
        codeExpiresAt: codeExpiresAt ? codeExpiresAt.toISOString() : null,
        freezeUntil: frozen && found.freezeUntil ? found.freezeUntil.toISOString() : null,
        freezeNotice: frozen && found.freezeUntil ? freezeMessage(found.freezeUntil) : null,
        rejectReason: status === 'REJECTED' ? found.rejectReason : null,
        attemptsLeft: Math.max(0, RECOVERY_MAX_ATTEMPTS - found.attempts),
      },
      request.requestId!
    );
  });

  // ── POST /recovery/message ───────────────────────────────────────────────
  app.post('/message', async (request) => {
    const parsed = messageSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Write a message first');
    await rateLimit(request, 'recoveryMsg', hashCode(parsed.data.ticket));

    const found = await findRequest(parsed.data.ticket);
    if (!found)
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'No recovery request matches that code');
    if (!threadOpen(found.status))
      throw new AppError(
        'RECOVERY_005',
        409,
        'This request is closed — file a new request if you still need help'
      );

    const entry: PublicThreadEntry = {
      from: 'PLAYER',
      body: parsed.data.body,
      at: new Date().toISOString(),
    };

    if (found.conversationId) {
      const msg = await prisma.supportMessage.create({
        data: {
          conversationId: found.conversationId,
          senderType: 'USER',
          userId: found.userId ?? null,
          body: parsed.data.body,
        },
      });
      await prisma.supportConversation.update({
        where: { id: found.conversationId },
        data: { updatedAt: new Date(), playerLastReadAt: new Date() },
      });
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      io?.to(`chat:${found.conversationId}`).emit('chat:message', {
        conversationId: found.conversationId,
        message: {
          id: msg.id,
          senderType: 'USER',
          body: msg.body,
          createdAt: msg.createdAt.toISOString(),
        },
      });
      emitAdmin('chat-message', {
        conversationId: found.conversationId,
        userId: found.userId ? shortId(found.userId) : null,
        message: msg.body.slice(0, 120),
        at: Date.now(),
      });
    } else {
      await prisma.recoveryRequest.update({
        where: { id: found.id },
        data: { answers: withThreadMessage(found.answers, entry) as never },
      });
      emitAdmin('recovery-message', {
        id: shortId(found.id),
        message: entry.body.slice(0, 120),
        at: Date.now(),
      });
    }

    return ok({ ok: true }, request.requestId!);
  });

  // ── POST /recovery/redeem ────────────────────────────────────────────────
  app.post('/redeem', async (request) => {
    await rateLimit(request, 'recoveryRedeem', request.ip);
    const parsed = redeemSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'Check the code and password'
      );

    const found = await findRequest(parsed.data.ticket);
    if (!found)
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'No recovery request matches that code');

    const guard = redeemGuard({
      status: found.status,
      codeHash: found.codeHash,
      codeExpiresAt: found.codeExpiresAt,
      attempts: found.attempts,
    });
    if (!guard.ok) {
      const locked = found.attempts >= RECOVERY_MAX_ATTEMPTS;
      throw new AppError(locked ? 'RECOVERY_006' : 'RECOVERY_004', locked ? 429 : 409, guard.reason!);
    }
    if (!found.userId)
      throw new AppError(
        'RECOVERY_002',
        409,
        'We could not match this request to an account — please message support in this ticket'
      );

    // Constant-time compare of the hash; never compare plaintext codes.
    if (!hashesEqual(hashCode(parsed.data.code), found.codeHash)) {
      const attempts = found.attempts + 1;
      const dead = attemptsExhausted(attempts);
      await prisma.recoveryRequest.update({
        where: { id: found.id },
        data: dead
          ? {
              attempts,
              status: 'EXPIRED',
              codeHash: null,
              codeEncrypted: null,
              codeExpiresAt: null,
            }
          : { attempts },
      });
      if (dead) {
        emitAdmin('recovery-code-locked', {
          id: shortId(found.id),
          userId: shortId(found.userId),
          at: Date.now(),
        });
        throw new AppError(
          'RECOVERY_006',
          429,
          'Too many incorrect codes — this request is closed. Contact support to start a new one.'
        );
      }
      throw new AppError(
        'RECOVERY_004',
        422,
        `That recovery code is not correct. ${RECOVERY_MAX_ATTEMPTS - attempts} attempt(s) left.`
      );
    }

    // ── Password policy on the RECOVERY door ──────────────────────────────
    // This route was the softest entrance in the platform: an agent hands out
    // the code, and the body only had to be 8 characters. A weak password here
    // would undo the signup policy, so the same rules apply — including the
    // common-password list and the "not your own phone number" check, plus
    // password-history reuse, because a reset must not be a way back to the
    // password the player was told to change.
    const person = await prisma.user.findUnique({
      where: { id: found.userId! },
      select: { phone: true, displayName: true, passwordHash: true },
    });
    const policy = await loadPasswordPolicy();
    const check = checkPassword(parsed.data.newPassword, {
      minLength: policy.minLength,
      rejectCommon: policy.rejectCommon,
      phone: person?.phone ?? null,
      displayName: person?.displayName ?? null,
    });
    if (!check.ok)
      throw new AppError(
        ERROR_CODES.AUTH_PASSWORD_WEAK,
        422,
        check.reason ?? 'Choose a stronger password'
      );
    const historyDepth = await getNumericSetting('password_history_depth', 3, { min: 0 });
    if (await isPasswordReused(found.userId!, parsed.data.newPassword, historyDepth))
      throw new AppError(
        ERROR_CODES.AUTH_PASSWORD_REUSED,
        422,
        'You have used this password before — choose a different one'
      );

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: found.userId! },
        data: { passwordHash },
      });
      await tx.recoveryRequest.update({
        where: { id: found.id },
        data: {
          status: 'REDEEMED',
          redeemedAt: now,
          attempts: 0,
          codeHash: null,
          codeEncrypted: null,
          codeExpiresAt: null,
        },
      });
    });

    // Password history: the replaced hash AND the new one, exactly as
    // change-password does — otherwise a recovery reset would be a way back to
    // the password the player was told to stop using.
    if (person?.passwordHash) {
      await recordPasswordHistory(found.userId!, person.passwordHash, historyDepth);
    }
    await recordPasswordHistory(found.userId!, passwordHash, historyDepth);

    // Everyone else is signed out: whoever held the old password is gone, and
    // a session the hijacker had is dead too.
    const revoked = await revokeAllSessions(found.userId, 'recovery_redeemed');

    const frozen = freezeActive(found.freezeUntil);
    const closing =
      'Your password has been changed and all devices were signed out. ' +
      (frozen && found.freezeUntil
        ? freezeMessage(found.freezeUntil)
        : 'You can log in with your new password now.');
    if (found.conversationId) {
      await prisma.supportMessage.create({
        data: {
          conversationId: found.conversationId,
          senderType: 'ADMIN',
          body: closing,
        },
      });
      await prisma.supportConversation.update({
        where: { id: found.conversationId },
        data: { status: 'CLOSED', adminLastReadAt: now, updatedAt: now },
      });
    }
    await notifyUser(
      found.userId,
      'Password changed',
      `${closing} If this was not you, contact support immediately.`,
      'security',
      '/profile'
    );
    emitAdmin('recovery-redeemed', {
      id: shortId(found.id),
      userId: shortId(found.userId),
      revoked,
      at: Date.now(),
    });

    return ok(
      {
        ok: true,
        status: 'REDEEMED',
        statusLabel: statusLabel('REDEEMED'),
        sessionsRevoked: revoked,
        freezeUntil: frozen && found.freezeUntil ? found.freezeUntil.toISOString() : null,
      },
      request.requestId!
    );
  });
}
