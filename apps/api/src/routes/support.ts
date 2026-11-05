// apps/api/src/routes/support.ts — conversations + messages + attachment stream.
//
// Player desk (slice 1): multiple tickets, category/reference, image attach,
// unread, closed threads stay closed.
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { ok, AppError } from '../lib/core';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { isSupportReferenceType } from '@casino/shared';
import { authMiddleware, rateLimit } from '../middleware';
import { prisma } from '../db/prisma';
import { MinioClient } from '../db/minio';
import { getJwtPublicKey } from '../lib/jwt-keys';
import { JWT_ISSUER_ADMIN, JWT_ISSUER_USER, JWT_ROLE_USER } from '../lib/jwt-claims';
import {
  resolveCategory,
  serializeMessage,
  playerConvoDto,
  lastMessagesByConvo,
  assertOwnUploadKey,
  SUPPORT_ATTACHMENT_SCOPE,
} from '../services/supportDesk';

const subjectSchema = z.object({
  subject: z.string().trim().min(1).max(120).optional(),
  category: z
    .enum(['deposit', 'withdrawal', 'game', 'account', 'bonus', 'other'])
    .optional(),
  referenceType: z.enum(['deposit', 'withdrawal']).optional(),
  referenceId: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(2000).optional(),
});

const messageSchema = z
  .object({
    message: z.string().trim().max(2000).optional(),
    attachmentUrl: z
      .string()
      .max(500)
      .regex(/^(https?:\/\/|\/)/, 'Attachment must be an http(s) URL or site path')
      .optional(),
    attachmentObjectKey: z.string().trim().min(8).max(500).optional(),
  })
  .refine((v) => !!(v.message && v.message.length > 0) || !!v.attachmentObjectKey, {
    message: 'Message or photo is required',
  });

export async function supportRoutes(app: FastifyInstance) {
  // Public help centre — guests see this before they log in to chat.
  app.get('/faqs', async (request) => {
    const cats = await prisma.faqCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: {
        faqs: {
          where: { isPublished: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            questionEn: true,
            questionUr: true,
            answerEn: true,
            answerUr: true,
            sortOrder: true,
          },
        },
      },
    });
    return ok(
      cats
        .filter((c) => c.faqs.length > 0)
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          nameEn: c.nameEn,
          nameUr: c.nameUr,
          sortOrder: c.sortOrder,
          faqs: c.faqs,
        })),
      request.requestId!
    );
  });

  app.post('/conversations', { preHandler: [authMiddleware] }, async (request) => {
    await rateLimit(request, 'supportConvo', request.user!.id);
    const parsed = subjectSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'Invalid subject'
      );
    const { category, subject } = resolveCategory(parsed.data);
    const referenceType = isSupportReferenceType(parsed.data.referenceType)
      ? parsed.data.referenceType
      : parsed.data.referenceId
        ? category === 'withdrawal'
          ? 'withdrawal'
          : category === 'deposit'
            ? 'deposit'
            : undefined
        : undefined;
    const referenceId = parsed.data.referenceId ?? undefined;

    if (referenceType && referenceId) {
      const existing = await prisma.supportConversation.findFirst({
        where: {
          userId: request.user!.id,
          referenceType,
          referenceId,
          status: { not: 'CLOSED' },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing) {
        if (parsed.data.message) {
          const msg = await prisma.supportMessage.create({
            data: {
              conversationId: existing.id,
              senderType: 'USER',
              userId: request.user!.id,
              body: parsed.data.message,
            },
          });
          await prisma.supportConversation.update({
            where: { id: existing.id },
            data: { updatedAt: new Date(), playerLastReadAt: new Date() },
          });
          const io = (globalThis as { __io?: import('socket.io').Server }).__io;
          io?.to(`chat:${existing.id}`).emit('chat:message', {
            conversationId: existing.id,
            message: serializeMessage(msg),
          });
        }
        return ok({ id: existing.id, reused: true }, request.requestId!);
      }
    }

    const convo = await prisma.supportConversation.create({
      data: {
        userId: request.user!.id,
        subject,
        category,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
        playerLastReadAt: new Date(),
      },
    });
    if (parsed.data.message) {
      const msg = await prisma.supportMessage.create({
        data: {
          conversationId: convo.id,
          senderType: 'USER',
          userId: request.user!.id,
          body: parsed.data.message,
        },
      });
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      io?.to(`chat:${convo.id}`).emit('chat:message', {
        conversationId: convo.id,
        message: serializeMessage(msg),
      });
      emitAdmin('chat-message', {
        conversationId: convo.id,
        userId: shortId(request.user!.id),
        message: msg.body.slice(0, 120),
        at: Date.now(),
      });
    }
    return ok({ id: convo.id, reused: false }, request.requestId!);
  });

  app.get('/conversations', { preHandler: [authMiddleware] }, async (request) => {
    const rows = await prisma.supportConversation.findMany({
      where: { userId: request.user!.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    const last = await lastMessagesByConvo(rows.map((r) => r.id));
    return ok(
      rows.map((c) => playerConvoDto(c, last.get(c.id) ?? null)),
      request.requestId!
    );
  });

  app.get(
    '/conversations/:id/messages',
    { preHandler: [authMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const convo = await prisma.supportConversation.findFirst({
        where: { id, userId: request.user!.id },
        select: { id: true },
      });
      if (!convo)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      const rows = await prisma.supportMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      });
      await prisma.supportConversation.update({
        where: { id },
        data: { playerLastReadAt: new Date() },
      });
      return ok(rows.map(serializeMessage), request.requestId!);
    }
  );

  app.post(
    '/conversations/:id/read',
    { preHandler: [authMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const updated = await prisma.supportConversation.updateMany({
        where: { id, userId: request.user!.id },
        data: { playerLastReadAt: new Date() },
      });
      if (updated.count !== 1)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      return ok({ ok: true }, request.requestId!);
    }
  );

  app.post(
    '/conversations/:id/messages',
    { preHandler: [authMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      await rateLimit(request, 'supportMsg', request.user!.id);
      const parsed = messageSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          parsed.error.issues[0]?.message ?? 'Invalid message'
        );
      const convo = await prisma.supportConversation.findFirst({
        where: { id, userId: request.user!.id },
        select: { id: true, status: true },
      });
      if (!convo)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Conversation not found');
      if (convo.status === 'CLOSED')
        throw new AppError(
          'CHAT_001',
          409,
          'This conversation is closed — open a new one from Support'
        );
      let attachmentUrl = parsed.data.attachmentObjectKey ?? undefined;
      if (attachmentUrl) {
        if (!assertOwnUploadKey(request.user!.id, attachmentUrl))
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Invalid attachment — upload the photo again'
          );
        const bucket = process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs';
        const stat = await MinioClient.statObject(bucket, attachmentUrl).catch(
          () => null
        );
        if (!stat)
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Photo not found — upload it again'
          );
      } else if (parsed.data.attachmentUrl) {
        attachmentUrl = parsed.data.attachmentUrl;
      }
      const msg = await prisma.supportMessage.create({
        data: {
          conversationId: id,
          senderType: 'USER',
          userId: request.user!.id,
          body: (parsed.data.message ?? '').trim(),
          attachmentUrl: attachmentUrl ?? null,
        },
      });
      await prisma.supportConversation.update({
        where: { id },
        data: { updatedAt: new Date(), playerLastReadAt: new Date() },
      });
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      const payload = { conversationId: id, message: serializeMessage(msg) };
      io?.to(`chat:${id}`).emit('chat:message', payload);
      emitAdmin('chat-message', {
        conversationId: id,
        userId: shortId(request.user!.id),
        message: (msg.body || '📎 Photo').slice(0, 120),
        at: Date.now(),
      });
      return ok(serializeMessage(msg), request.requestId!);
    }
  );

  // Signed (or owner) image stream for chat attachments. Same bucket as deposit proofs.
  app.get('/attachments/*', async (request, reply) => {
    const key = (request.params as { '*': string })['*'];
    if (!key || key.length > 500 || key.includes('..'))
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Not found');
    const st = (request.query as { st?: string }).st;
    let allowed = false;
    if (st) {
      try {
        const payload = jwt.verify(st, getJwtPublicKey(), {
          algorithms: ['RS256'],
          issuer: JWT_ISSUER_ADMIN,
        }) as { scope?: string; k?: string };
        if (payload.scope === SUPPORT_ATTACHMENT_SCOPE && payload.k === key)
          allowed = true;
      } catch {
        /* fall through */
      }
    }
    if (!allowed) {
      const bearer = request.headers.authorization;
      const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : '';
      if (token) {
        try {
          const payload = jwt.verify(token, getJwtPublicKey(), {
            algorithms: ['RS256'],
            issuer: JWT_ISSUER_USER,
          }) as { sub?: string; role?: string };
          if (payload.role === JWT_ROLE_USER && payload.sub) {
            const owned = await prisma.supportMessage.findFirst({
              where: {
                attachmentUrl: key,
                conversation: { userId: payload.sub },
              },
              select: { id: true },
            });
            if (owned || assertOwnUploadKey(payload.sub, key)) allowed = true;
          }
        } catch {
          allowed = false;
        }
      }
    }
    if (!allowed) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Not found');
    try {
      const stream = await MinioClient.getObject(
        process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs',
        key
      );
      const contentType = key.toLowerCase().endsWith('.png')
        ? 'image/png'
        : key.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
      reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'private, max-age=300');
      return reply.send(stream);
    } catch {
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Not found');
    }
  });
}
