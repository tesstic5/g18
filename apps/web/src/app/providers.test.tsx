// @vitest-environment jsdom
// apps/web/src/app/providers.test.tsx — D-091: THE reload fix. Login/signup use
// router.push (SPA — no page reload), so the mount-time session-restore never
// re-ran and the socket stayed disconnected: notifications/balance/deposit
// events only arrived after a manual reload. The auth-store subscription must
// connect the socket the moment a token appears and drop it on logout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

// Hand-written on purpose: the REAL lib/app opens a socket.io connection and a
// cache at import time, so it must never be loaded in jsdom.
vi.mock('../lib/app', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return {
    queryClient: new QueryClient(),
    socket: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    },
    connectSocket: vi.fn(),
  };
});
vi.mock('../lib/env', () => ({ apiBaseUrl: () => 'http://localhost:4000/api/v1' }));
// Spread the REAL module and override only what this test needs: listing
// exports by hand silently breaks every consumer that imports something else
// from here — `stores.logout()` calls forgetCsrf(), and the missing export
// surfaced as an unhandled rejection that failed the whole run (all 69 tests
// green, exit code 1).
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: vi.fn().mockRejectedValue(new Error('no session')),
    http: { get: vi.fn() },
  };
});

import { socket, connectSocket } from '../lib/app';
import { useAuthStore } from '../stores';
import { Providers } from './providers';

afterEach(() => cleanup());

beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, hydrated: true });
  vi.mocked(connectSocket).mockClear();
  vi.mocked(socket.disconnect).mockClear();
  // guest session restore — no refresh cookie
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, json: async () => null })
  );
});

describe('Providers — socket follows the auth state (D-091)', () => {
  it('connects the socket when a token appears AFTER mount (SPA login, no reload)', async () => {
    render(React.createElement(Providers, null, React.createElement('div', null, 'x')));
    expect(vi.mocked(connectSocket)).not.toHaveBeenCalled(); // guest at mount
    // simulate the login page: setSession with a fresh token (no navigation)
    useAuthStore
      .getState()
      .setSession({ id: 'u1', phone: '+92000000000' }, 'fresh-token');
    await new Promise((r) => setTimeout(r, 20));
    // at least once — the subscription fires on the token change (the
    // mount-time session restore may also call it; connectSocket is guarded
    // by socket.connected so repeats are no-ops)
    expect(vi.mocked(connectSocket)).toHaveBeenCalled();
  });

  it('disconnects the socket when the user logs out, so the next login reconnects fresh', async () => {
    render(React.createElement(Providers, null, React.createElement('div', null, 'x')));
    useAuthStore.getState().setSession({ id: 'u1', phone: '+92000000000' }, 't');
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(connectSocket)).toHaveBeenCalled();
    useAuthStore.getState().logout();
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(socket.disconnect)).toHaveBeenCalled();
  });
});
