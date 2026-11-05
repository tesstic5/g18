// @vitest-environment jsdom
// apps/web/src/components/NotificationBell.test.tsx — D-091: the bell dropdown
// must OPEN on click (it previously painted under the game page's own top bar
// on game routes, which looked like the bell "did nothing"). The dropdown now
// renders through a portal to <body> at z-[200], so no layout can cover it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, waitFor, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

afterEach(() => cleanup());

let pathname = '/games/dice';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('../lib/api', () => ({
  http: { get: vi.fn(), post: vi.fn() },
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, msg: string) {
      super(msg);
      this.status = status;
    }
  },
  uuid: () => 'u',
}));
vi.mock('../lib/app', () => ({
  socket: { on: vi.fn(), off: vi.fn() },
}));

import { http } from '../lib/api';
import { useAuthStore } from '../stores';
import { NotificationBell } from './ui';

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(NotificationBell)
    )
  );
}

beforeEach(() => {
  pathname = '/games/dice';
  useAuthStore.setState({
    user: { id: 'u1', phone: '+92000000000' },
    accessToken: 't',
    hydrated: true,
  });
  // simulate the server: after mark-all-read the refetched list is read=true
  let fetchCount = 0;
  vi.mocked(http.get).mockImplementation(async () => {
    fetchCount++;
    return [
      {
        id: 'n1',
        title: 'Deposit approved',
        body: '₨500 added',
        type: 'deposit',
        isRead: fetchCount > 1,
      },
    ];
  });
  vi.mocked(http.post).mockResolvedValue({ readAll: true });
});

describe('NotificationBell (D-091)', () => {
  it('opens the dropdown on click — portal child of <body>, z-[200], never hidden by page chrome', async () => {
    renderBell();
    // dropdown NOT in the document before the click
    expect(screen.queryByText('Deposit approved')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText('Deposit approved')).toBeTruthy());
    const dropdown = screen
      .getByText('Deposit approved')
      .closest('.fixed') as HTMLElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.parentElement).toBe(document.body); // portal → above all page stacking
    expect(dropdown.className).toContain('z-[200]');
    // unread badge shows
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('marks all read via the API and clears the badge', async () => {
    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText('Mark all read')).toBeTruthy());
    fireEvent.click(screen.getByText('Mark all read'));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/notifications/read-all', undefined)
    );
    await waitFor(() => expect(screen.queryByText('1')).toBeNull());
  });

  it('closes the dropdown when the route changes', async () => {
    const { rerender } = renderBell();
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText('Deposit approved')).toBeTruthy());
    pathname = '/wallet';
    rerender(
      React.createElement(
        QueryClientProvider,
        {
          client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        },
        React.createElement(NotificationBell)
      )
    );
    expect(screen.queryByText('Deposit approved')).toBeNull();
  });
});
