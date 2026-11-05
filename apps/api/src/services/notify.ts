// apps/api/src/services/notify.ts — notification helper (D-061).
// Creates a Notification row and pushes `notification:new` over socket.io so
// the bell updates instantly for the target user.
import { prisma } from '../db/prisma';

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  type: string,
  actionUrl?: string
) {
  try {
    const notif = await prisma.notification.create({
      data: {
        userId,
        type,
        title: title.slice(0, 120),
        body: body.slice(0, 500),
        actionUrl,
      },
    });
    const io = (globalThis as { __io?: import('socket.io').Server }).__io;
    io?.to(`user:${userId}`).emit('notification:new', {
      id: notif.id,
      type: notif.type,
      title: notif.title,
      body: notif.body,
      actionUrl: notif.actionUrl,
    });
  } catch (e) {
    // never break the primary flow because of a notification

    console.error('[notify] failed:', (e as Error).message);
  }
}
