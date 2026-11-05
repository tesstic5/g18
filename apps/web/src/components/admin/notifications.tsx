// apps/web/src/components/admin/notifications.tsx — D-079: admin notification
// stream. Connects with the short-lived admin ws-token and listens for:
//   admin:chat-message (player sent a support message)
//   admin:new-deposit / admin:withdrawal-request / admin:new-signup / admin:live-bet
// Shows a toast + keeps unread counts per section; the panel sidebar renders
// badges next to Support / Deposits / Withdrawals.
//
// Slice 1: the same socket is exposed so SupportInbox can chat:join / chat:send
// (the player socket in lib/app.ts cannot — admin userId is empty).
'use client';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io } from 'socket.io-client';
import { http } from '../../lib/api';
import { wsBaseUrl } from '../../lib/env';
import { notify } from '../../lib/toast';

interface AdminNotifState {
  unread: Record<string, number>;
  clear: (key: string) => void;
  socket: ReturnType<typeof io> | null;
}

const Ctx = createContext<AdminNotifState>({
  unread: {},
  clear: () => {},
  socket: null,
});
export const useAdminNotifs = () => useContext(Ctx);

export function AdminNotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [liveSocket, setLiveSocket] = useState<ReturnType<typeof io> | null>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);

  const bump = useCallback((key: string, toastTitle: string, toastBody: string) => {
    setUnread((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 }));
    notify.info(`${toastTitle} — ${toastBody}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sock = io(wsBaseUrl(), {
      auth: (cb) => {
        http
          .get<{ token: string }>('/panel/auth/ws-token')
          .then(({ token }) => cb({ token }))
          .catch(() => cb({}));
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 3000,
    });
    socketRef.current = sock;
    setLiveSocket(sock);
    sock.on('admin:chat-message', (p: { conversationId: string; message: string }) => {
      if (cancelled) return;
      bump('support', '💬 New support message', p.message.slice(0, 90));
    });
    sock.on('admin:new-deposit', (p: { amount: number; status?: string }) => {
      if (cancelled) return;
      bump(
        'deposits',
        '📥 New deposit request',
        `₨${Number(p.amount ?? 0).toLocaleString()} awaiting review`
      );
    });
    sock.on('admin:withdrawal-request', (p: { amount: number; netAmount: number }) => {
      if (cancelled) return;
      bump(
        'withdrawals',
        '📤 New withdrawal request',
        `₨${Number(p.netAmount ?? 0).toLocaleString()} to review`
      );
    });
    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      setLiveSocket(null);
    };
  }, [bump]);

  const clear = useCallback(
    (key: string) => setUnread((u) => ({ ...u, [key]: 0 })),
    []
  );

  return (
    <Ctx.Provider value={{ unread, clear, socket: liveSocket }}>
      {children}
    </Ctx.Provider>
  );
}
