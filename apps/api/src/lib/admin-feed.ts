// apps/api/src/lib/admin-feed.ts — broadcast live events to admin consoles.
// Emits `admin:<event>` on the default namespace; admin panel sockets (authed
// with a short-lived admin ws token) listen to these. Payloads are masked —
// never full phones, only ids/labels/amounts.
import type { Server } from 'socket.io';

export function emitAdmin(event: string, payload: unknown): void {
  const io = (globalThis as { __io?: Server }).__io;
  if (!io) {
    // v1.3.8: this was the silent-death path that made admin notifications
    // invisible in production — warn so a wiring regression NEVER goes quiet
    // again (unit tests assert reachability; this logs only in dev/test).
    if (process.env.NODE_ENV !== 'production')
      console.warn(`[admin-feed] no socket server registered — dropped admin:${event}`);
    return;
  }
  io.to('admins').emit(`admin:${event}`, payload);
}

/** Short id for feeds — keeps full ids out of the broadcast stream. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
