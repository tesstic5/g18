// packages/shared/src/constants/panel-perms.ts
//
// SINGLE SOURCE OF TRUTH for the admin panel's route → permission mapping.
//
// WHY THIS LIVES IN SHARED
// ------------------------
// The API enforces these flags in `adminAuthMiddleware` (DEFAULT-DENY: a
// route absent from this map is super-admin only). The web panel renders its
// side nav from the same data. Keeping two hand-maintained copies invites the
// exact failure this file exists to prevent: the nav shows a section the
// server then rejects with 403 (or hides one the operator is allowed to use).
// The UI filter is a CONVENIENCE only — the server check is authoritative.

/** The six permission flags an AdminUser can hold. */
export type PermFlag =
  | 'permFinancial'
  | 'permUsers'
  | 'permReporting'
  | 'permChat'
  | 'permGames'
  | 'permSettings';

export const ALL_PERM_FLAGS: readonly PermFlag[] = [
  'permFinancial',
  'permUsers',
  'permReporting',
  'permChat',
  'permGames',
  'permSettings',
];

/**
 * Permission required per panel route (matched by longest prefix — see
 * `permForPath` below).
 *
 * DEFAULT-DENY: routes absent from this map are super-admin only. That is
 * deliberate, so a new panel route can never silently become reachable by
 * every manager. `/panel/backup/*` relies on it. `/panel/managers` is an
 * intentional exception — any authenticated admin may access it (server
 * enforces: admin cannot touch super admins; super admin can do anything),
 * and the web panel shows the tab to all admins via layout canSee bypass.
 */
export const PANEL_ROUTE_PERM: Record<string, PermFlag> = {
  // Finance
  '/panel/deposits': 'permFinancial',
  '/panel/withdrawals': 'permFinancial',
  '/panel/transactions': 'permFinancial',
  '/panel/payment-accounts': 'permFinancial',
  // coin packages appear in the Finance nav — superadmin-only previously.
  '/panel/packages': 'permFinancial',
  // Players
  '/panel/users': 'permUsers',
  // Parked dual-control credits are a FINANCIAL queue: clearing one moves money.
  '/panel/wallet-adjustments': 'permFinancial',
  // Monitoring is read-only operational insight.
  '/panel/monitoring': 'permReporting',
  '/panel/fraud-signals': 'permUsers',
  // Account recovery console — agents verify evidence (approval itself is
  // super-admin + dual control, enforced inside the route).
  '/panel/recovery': 'permUsers',
  // Games
  '/panel/games': 'permGames',
  // Reporting / read-only insight
  '/panel/reports': 'permReporting',
  '/panel/dashboard': 'permReporting',
  '/panel/audit-log': 'permReporting',
  // Support
  '/panel/support': 'permChat',
  '/panel/faqs': 'permChat',
  '/panel/faq-categories': 'permChat',
  // Settings & content
  '/panel/settings': 'permSettings',
  '/panel/legal': 'permSettings',
  '/panel/broadcasts': 'permSettings',
  // NOTE: /panel/backup/* is deliberately NOT listed — it falls through to
  // default-deny (super-admin only). /panel/managers is also not listed but
  // is allowed for any admin via explicit bypass in API middleware +
  // panel layout (hierarchy enforced in handlers).
};

/**
 * Permission flags held by the signed-in admin. A super-admin short-circuits
 * every server-side check, so it is reported as holding all six — otherwise
 * the nav would hide sections the server would happily serve.
 */
export type AdminPermissions = Record<PermFlag, boolean>;

/**
 * Resolve the permission a panel PATH requires, or `undefined` for
 * default-deny (super-admin only).
 *
 * Shared by the API's `permFor` (enforcement) and the web panel's side nav
 * (filtering), so the two can never disagree about who may see what.
 *
 * The API path must already be normalized (mount prefix + query stripped).
 */
export function permForPath(path: string): PermFlag | undefined {
  // Crediting/debiting a player's wallet is a FINANCIAL action even though
  // the route lives under /panel/users/:id — require permFinancial, not
  // permUsers.
  if (/^\/panel\/users\/[^/]+\/fund$/.test(path)) return 'permFinancial';

  // The panel ROOT is the Dashboard page (apps/web/src/app/panel/page.tsx).
  // It renders dashboard stats, so gate it with the same flag those stats use.
  // EXACT match only — mapping the bare "/panel" prefix would make every
  // unmapped child route (backup, managers…) resolve to permReporting and
  // silently undo default-deny.
  if (path === '/panel') return 'permReporting';

  return Object.keys(PANEL_ROUTE_PERM)
    .filter((p) => path === p || path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)
    .map((p) => PANEL_ROUTE_PERM[p])[0];
}
