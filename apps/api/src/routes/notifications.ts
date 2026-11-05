// apps/api/src/routes/notifications.ts — bell, read, read-all (v4)
//
// M-05: BROADCAST rows (userId = null) are shared by every player, so the
// read flag cannot live on them — one player's "mark read" would be shown to
// nobody (the old code only updated rows with the player's own id, so
// broadcasts stayed unread forever in every bell and unread count). Read
// state for broadcasts now lives in NotificationRead, keyed per user, and is
// overlaid onto the shared rows on read.
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    const rows = await prisma.notification.findMany({
      where: {
        OR: [{ userId }, { userId: null, isRetracted: false }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // Overlay per-user read state onto the shared broadcast rows.
    const broadcastIds = rows.filter((r) => r.userId === null).map((r) => r.id);
    const reads = broadcastIds.length
      ? await prisma.notificationRead.findMany({
          where: { userId, notificationId: { in: broadcastIds } },
          select: { notificationId: true },
        })
      : [];
    const readSet = new Set(reads.map((r) => r.notificationId));
    const withRead = rows.map((r) =>
      r.userId === null ? { ...r, isRead: readSet.has(r.id) } : r
    );
    return ok(withRead, request.requestId!);
  });

  app.post('/:id/read', { preHandler: [authMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const target = await prisma.notification.findUnique({
      where: { id },
      select: { userId: true, isRetracted: true },
    });
    if (!target) return ok({ read: true }, request.requestId!);
    if (target.userId === userId) {
      // personal row — the flag is really ours
      await prisma.notification.updateMany({
        where: { id, userId },
        data: { isRead: true },
      });
    } else if (target.userId === null && !target.isRetracted) {
      // broadcast row — record OUR read, leave everyone else's alone
      await prisma.notificationRead.upsert({
        where: { notificationId_userId: { notificationId: id, userId } },
        create: { notificationId: id, userId },
        update: {},
      });
    }
    return ok({ read: true }, request.requestId!);
  });

  app.post('/read-all', { preHandler: [authMiddleware] }, async (request) => {
    const userId = request.user!.id;
    const [broadcasts] = await prisma.$transaction([
      prisma.notification.findMany({
        where: { userId: null, isRetracted: false },
        select: { id: true },
      }),
      prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      }),
    ]);
    if (broadcasts.length)
      await prisma.notificationRead.createMany({
        data: broadcasts.map((b) => ({ notificationId: b.id, userId })),
        skipDuplicates: true,
      });
    return ok({ readAll: true }, request.requestId!);
  });
}
