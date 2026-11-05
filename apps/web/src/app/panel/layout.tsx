// apps/web/src/app/panel/layout.tsx — professional admin shell (D-068)
// Guarded: nothing renders unless /panel/auth/me succeeds (admin cookie).
'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { http, rememberCsrf, forgetCsrf, ApiError } from '../../lib/api';
import { Icon } from '../../components/admin/ui';
import { notify } from '../../lib/toast';
import {
  AdminNotificationsProvider,
  useAdminNotifs,
} from '../../components/admin/notifications';
import {
  permForPath,
  type AdminPermissions,
} from '@casino/shared/constants/panel-perms';

const NAV: Array<{ group: string; items: Array<[string, string, string]> }> = [
  { group: 'Overview', items: [['/panel', 'Dashboard', 'dashboard']] },
  {
    group: 'Players',
    items: [
      ['/panel/users', 'Users', 'users'],
      ['/panel/recovery', 'Account Recovery', 'shield'],
    ],
  },
  {
    group: 'Finance',
    items: [
      ['/panel/deposits', 'Deposits', 'deposits'],
      ['/panel/withdrawals', 'Withdrawals', 'withdrawals'],
      ['/panel/transactions', 'Transactions', 'ledger'],
      ['/panel/payment-accounts', 'Payment Accounts', 'cards'],
      ['/panel/payfast', 'PayFast Gateway', 'cards'],
      ['/panel/packages', 'Deposit Packages', 'cards'],
    ],
  },
  {
    group: 'Games',
    items: [
      ['/panel/games', 'Games', 'games'],
      ['/panel/reports', 'Reports', 'reports'],
    ],
  },
  {
    group: 'Engage',
    items: [
      ['/panel/broadcasts', 'Broadcasts', 'broadcast'],
      ['/panel/legal', 'Legal Pages', 'legal'],
    ],
  },
  {
    group: 'Service',
    items: [
      ['/panel/support', 'Support Inbox', 'support'],
      ['/panel/faqs', 'FAQs', 'legal'],
    ],
  },
  {
    group: 'System',
    items: [
      ['/panel/settings', 'Settings', 'settings'],
      ['/panel/settings/email', 'Email Settings', 'bell'],
      ['/panel/managers', 'Managers', 'managers'],
      ['/panel/referral-users', 'Referral Users', 'managers'],
      ['/panel/audit-log', 'Audit Log', 'audit'],
      ['/panel/backup', 'Backup & Restore', 'backup'],
      ['/panel/fraud-signals', 'Fraud Signals', 'shield'],
      ['/panel/monitoring', 'Monitoring', 'chart'],
    ],
  },
];

const NOTIF_KEY: Record<string, string> = {
  '/panel/support': 'support',
  '/panel/deposits': 'deposits',
  '/panel/withdrawals': 'withdrawals',
};

const TITLES: Record<string, string> = {
  '/panel': 'Dashboard',
  '/panel/users': 'Users',
  '/panel/deposits': 'Deposits',
  '/panel/withdrawals': 'Withdrawals',
  '/panel/transactions': 'Transactions',
  '/panel/payment-accounts': 'Payment Accounts',
  '/panel/packages': 'Deposit Packages',
  '/panel/games': 'Games',
  '/panel/reports': 'Reports',
  '/panel/broadcasts': 'Broadcasts',
  '/panel/legal': 'Legal Pages',
  '/panel/support': 'Support Inbox',
  '/panel/faqs': 'FAQs',
  '/panel/settings': 'Settings',
  '/panel/managers': 'Managers',
  '/panel/referral-users': 'Referral Users',
  '/panel/audit-log': 'Audit Log',
  '/panel/backup': 'Backup & Restore',
  '/panel/settings/email': 'Email Settings',
  '/panel/fraud-signals': 'Fraud Signals',
  '/panel/recovery': 'Account Recovery',
  '/panel/monitoring': 'Monitoring',
};

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState<null | boolean>(null);
  const [adminName, setAdminName] = useState('');
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  // null until /panel/auth/me resolves, so the nav never renders a section
  // this manager cannot open. Super-admins short-circuit server-side, so they
  // are reported as holding every flag.
  const [perms, setPerms] = useState<AdminPermissions | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isLoginPage = pathname === '/panel/login';

  useEffect(() => {
    if (isLoginPage) {
      setAuthed(false);
      return;
    }
    let alive = true;
    http
      .get<{
        username: string;
        csrfToken?: string;
        isSuperAdmin?: boolean;
        permissions?: AdminPermissions;
      }>('/panel/auth/me')
      .then((me) => {
        if (alive) {
          rememberCsrf(me.csrfToken);
          setAdminName(me.username);
          setIsSuperAdmin(me.isSuperAdmin === true);
          setPerms(me.permissions ?? null);
          setAuthed(true);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // Say why: an auth failure here usually means the browser never stored
        // the session cookie (Secure-over-http, or panel and API on different
        // hosts). The login page turns ?reason=session into that explanation.
        const authProblem =
          err instanceof ApiError &&
          (err.status === 401 ||
            err.status === 403 ||
            err.code === 'AUTH_TOKEN_INVALID' ||
            err.code === 'AUTH_TOKEN_EXPIRED');
        router.replace(authProblem ? '/panel/login?reason=session' : '/panel/login');
      });
    return () => {
      alive = false;
    };
  }, [router, isLoginPage]);

  if (!isLoginPage && authed !== true) {
    return (
      <div className="min-h-screen bg-layer-floor flex flex-col items-center justify-center gap-4">
        <div className="h-9 w-9 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
        <p className="t-label-sm text-muted">Checking admin session…</p>
      </div>
    );
  }

  if (isLoginPage) return <>{children}</>;

  const logout = async () => {
    await http.post('/panel/auth/logout').catch(() => {});
    forgetCsrf();
    notify.success('Logged out');
    window.location.href = '/panel/login';
  };

  return (
    <AdminNotificationsProvider>
      <ShellInner
        adminName={adminName}
        pathname={pathname}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        logout={logout}
        isSuperAdmin={isSuperAdmin}
        perms={perms}
      >
        {children}
      </ShellInner>
    </AdminNotificationsProvider>
  );
}

function ShellInner({
  children,
  adminName,
  pathname,
  sidebarOpen,
  setSidebarOpen,
  logout,
  isSuperAdmin,
  perms,
}: {
  children: React.ReactNode;
  adminName: string;
  pathname: string;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  logout: () => void;
  isSuperAdmin: boolean;
  perms: AdminPermissions | null;
}) {
  // Mirror the API's adminAuthMiddleware: a route the manager lacks the flag
  // for is hidden, an unmapped route (backup) is super-admin only.
  // Exception: /panel/managers is intentionally visible to any authenticated
  // admin — hierarchy is enforced server-side (admin can manage managers but
  // never touch a super admin; super admin can do anything). This matches the
  // adminAuthMiddleware bypass for /panel/managers.
  const canSee = (href: string) => {
    if (isSuperAdmin) return true;
    if (!perms) return false;
    // Managers tab: any admin may view/manage other admins/managers (server
    // enforces that admin cannot edit super admins).
    if (href === '/panel/managers' || href.startsWith('/panel/managers/')) return true;
    // Referral users: visible to any admin; the API requires super-admin for
    // every mutation, so non-super admins see the list read-only.
    if (href === '/panel/referral-users') return true;
    const flag = permForPath(href);
    return flag ? perms[flag] === true : false;
  };
  const nav = NAV.map((g) => ({
    ...g,
    items: g.items.filter(([href]) => canSee(href)),
  })).filter((g) => g.items.length > 0);
  const { unread, clear } = useAdminNotifs();
  const title = TITLES[pathname] ?? 'Admin';
  // The single best (longest) nav href for this path — see the item render.
  const activeHref = (() => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i[0]));
    const matches = hrefs.filter(
      (h) => pathname === h || (h !== '/panel' && pathname.startsWith(h + '/'))
    );
    matches.sort((a, b) => b.length - a.length);
    return matches[0] ?? null;
  })();
  // clear the badge when the admin visits that section
  useEffect(() => {
    if (pathname.startsWith('/panel/support')) clear('support');
    if (pathname.startsWith('/panel/deposits')) clear('deposits');
    if (pathname.startsWith('/panel/withdrawals')) clear('withdrawals');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div className="min-h-screen bg-layer-floor">
      {/* Mobile topbar */}
      <div className="lg:hidden sticky top-0 z-40 h-14 bg-layer-surface border-b border-white/8 flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="h-9 w-9 rounded-lg bg-white/5 flex items-center justify-center text-white/80"
          >
            <Icon name="chevron" size={16} className="rotate-90" />
          </button>
          <img
            src="/icons/wordmark.png"
            alt="2 Win 2 Play"
            className="h-7 w-auto max-w-[160px] object-contain"
          />
          {(unread.support ?? 0) > 0 && (
            <span className="ml-1.5 h-5 min-w-5 px-1 rounded-full bg-red text-white text-[10px] font-bold flex items-center justify-center">
              {unread.support}
            </span>
          )}
        </div>
        <button
          onClick={logout}
          className="relative h-9 w-9 rounded-lg bg-white/5 flex items-center justify-center text-red/80"
        >
          <Icon name="logout" size={16} />
          {(unread.support ?? 0) > 0 && (
            <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 rounded-full bg-red text-white text-[9px] font-bold flex items-center justify-center">
              {unread.support}
            </span>
          )}
        </button>
      </div>

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-layer-surface border-r border-white/8 flex flex-col transition-transform lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-16 flex items-center justify-between px-5 border-b border-white/8">
          <div className="min-w-0">
            <img
              src="/icons/wordmark.png"
              alt="2 Win 2 Play"
              className="h-9 w-auto max-w-[180px] object-contain"
            />
            <span className="block t-label-sm text-muted mt-0.5">Admin Console</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-white/60"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-4">
          {nav.map((g) => (
            <div key={g.group}>
              <p className="t-label-sm uppercase tracking-widest text-white/25 px-3 mb-1.5">
                {g.group}
              </p>
              {g.items.map(([href, label, icon]) => {
                // Longest match wins. Plain startsWith lit up BOTH "Settings"
                // and a nested "Email Settings" at once, which reads as a bug.
                const active = activeHref === href;
                const base = pathname === href || pathname.startsWith(href + '/');
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setSidebarOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg t-label-md transition-colors mb-0.5 ${active ? 'bg-gold/12 text-gold' : 'text-white/55 hover:text-white/90 hover:bg-white/4'}`}
                  >
                    <span className={active ? 'text-gold' : 'text-white/35'}>
                      <Icon name={icon} size={16} />
                    </span>
                    {label}
                    {base && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full bg-gold" />
                    )}
                    {NOTIF_KEY[href] && (unread[NOTIF_KEY[href]] ?? 0) > 0 && (
                      <span className="ml-auto h-5 min-w-5 px-1.5 rounded-full bg-red text-white text-[10px] font-bold flex items-center justify-center">
                        {unread[NOTIF_KEY[href]]}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-4 border-t border-white/8 space-y-1">
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="h-8 w-8 rounded-full bg-gold/15 text-gold flex items-center justify-center t-label-md">
              {adminName.slice(0, 1).toUpperCase()}
            </span>
            <span className="t-label-sm text-white/70 truncate">{adminName}</span>
          </div>
          <Link
            href="/"
            target="_blank"
            className="flex items-center gap-2 px-3 py-2 rounded-lg t-label-md text-white/45 hover:text-white/80 hover:bg-white/4"
          >
            <Icon name="external" size={15} /> View live site
          </Link>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg t-label-md text-red/70 hover:text-red hover:bg-red/8"
          >
            <Icon name="logout" size={15} /> Logout
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main */}
      <main className="lg:ml-64 p-4 lg:p-8 max-w-[1400px]">
        <div className="hidden lg:flex items-center justify-between mb-6">
          <h1 className="t-title text-primary">{title}</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              target="_blank"
              className="h-9 px-3 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/60 hover:text-white/90 inline-flex items-center gap-1.5"
            >
              <Icon name="external" size={14} /> View site
            </Link>
            <button
              onClick={logout}
              className="h-9 px-3 rounded-lg bg-red/10 border border-red/25 t-label-md text-red hover:bg-red/20 inline-flex items-center gap-1.5"
            >
              <Icon name="logout" size={14} /> Logout
            </button>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
