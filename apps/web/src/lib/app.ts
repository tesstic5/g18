// apps/web/src/lib/app.ts — query client, socket singleton, WebCrypto seed gen,
// IndexedDB offline cache, network status. (docs/19 §22, docs/22 §offline/§webcrypto)
import { QueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores';
import { safeSession, createSafeCache } from './safe-storage';
import { wsBaseUrl } from './env';

// ── React Query (docs/22 §fetch/§cache) ────────────────────────────────────
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

/** Invalidation rules after mutations (docs/22 §cache): */
export const invalidate = {
  balance: () => queryClient.invalidateQueries({ queryKey: ['balance'] }),
  transactions: () => queryClient.invalidateQueries({ queryKey: ['transactions'] }),
  gameHistory: (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ['history', slug] }),
  lobby: () => queryClient.invalidateQueries({ queryKey: ['games'] }),
  leaderboard: (p: string) =>
    queryClient.invalidateQueries({ queryKey: ['leaderboard', p] }),
  notifications: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  sessionStats: () => queryClient.invalidateQueries({ queryKey: ['session-stats'] }),
  checkin: () => {
    void queryClient.invalidateQueries({ queryKey: ['checkin'] });
    void queryClient.invalidateQueries({ queryKey: ['checkin-home'] });
  },
};

// ── Socket singleton (v4 spec + docs/22 §offline) ──────────────────────────
export const socket: Socket = io(wsBaseUrl(), {
  autoConnect: false,
  auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.3,
});

export function connectSocket() {
  if (!socket.connected) socket.connect();
}
socket.on('connect', () => {
  // rejoin rooms + resync (docs/19 §22)
  const slug = safeSession.get('currentGame');
  if (slug) socket.emit('game:join', { slug });
  queryClient.invalidateQueries({ queryKey: ['balance'] });
});
socket.on('disconnect', (reason) => {
  // D-099: only treat a server disconnect as auth failure when a token was
  // present — guests connect without a token and must NOT be bounced to login.
  if (reason === 'io server disconnect' && useAuthStore.getState().accessToken)
    useAuthStore.getState().logout();
});

// ── WebCrypto client-side seed generation (docs/22 §webcrypto) ─────────────
// Client seed is user-controlled; server seed stays server-side. This only
// supplies entropy for the CLIENT seed via crypto.getRandomValues (never Math.random).
export function generateClientSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── IndexedDB offline cache (docs/22 §offline) — never throws (safe-storage) ──
export const offlineDb = createSafeCache<unknown>('kv');

// ── Network status (docs/19 §22) ───────────────────────────────────────────
export function useNetworkStatus(): boolean {
  // tiny hook wrapper — see hooks/index.ts useNetworkStatus
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}
