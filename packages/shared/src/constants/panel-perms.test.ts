// packages/shared/src/constants/panel-perms.test.ts
//
// The panel permission map is a SECURITY control: the API enforces it in
// adminAuthMiddleware (default-deny) and the web panel filters its side nav
// with the same resolver. A wrong mapping either 403s a manager out of a
// section they need, or — far worse — silently widens access. These tests pin
// both directions.
import { describe, expect, it } from 'vitest';
import {
  PANEL_ROUTE_PERM,
  ALL_PERM_FLAGS,
  permForPath,
  type PermFlag,
} from './panel-perms';

const VALID_FLAGS = new Set<string>(ALL_PERM_FLAGS);

describe('panel permission map', () => {
  it('maps only real permission flags', () => {
    for (const [route, flag] of Object.entries(PANEL_ROUTE_PERM)) {
      expect(VALID_FLAGS.has(flag), `${route} -> ${flag}`).toBe(true);
    }
  });

  it('lists all six flags exactly once', () => {
    expect([...ALL_PERM_FLAGS].sort()).toEqual(
      [
        'permChat',
        'permFinancial',
        'permGames',
        'permReporting',
        'permSettings',
        'permUsers',
      ].sort()
    );
  });
});

describe('permForPath', () => {
  it('resolves every mapped route to its flag', () => {
    for (const [route, flag] of Object.entries(PANEL_ROUTE_PERM)) {
      expect(permForPath(route), route).toBe(flag);
      // and one level deeper, as a sub-resource would be requested
      expect(permForPath(`${route}/123`), `${route}/123`).toBe(flag);
    }
  });

  it('is DEFAULT-DENY for unmapped routes (super-admin only)', () => {
    // These are the two the map deliberately omits (see the map's NOTE).
    expect(permForPath('/panel/backup')).toBeUndefined();
    expect(permForPath('/panel/backup/restore')).toBeUndefined();
    expect(permForPath('/panel/managers')).toBeUndefined();
    expect(permForPath('/panel/managers/abc')).toBeUndefined();
    // An unknown future route must fail CLOSED, not open.
    expect(permForPath('/panel/something-new')).toBeUndefined();
  });

  it('treats funding a player as a FINANCIAL action, not a users action', () => {
    // The route lives under /panel/users/:id but moves real money.
    expect(permForPath('/panel/users/abc123/fund')).toBe('permFinancial');
    // ...while the surrounding users routes stay on permUsers.
    expect(permForPath('/panel/users')).toBe('permUsers');
    expect(permForPath('/panel/users/abc123')).toBe('permUsers');
  });

  it('gates the panel root (the Dashboard page) with permReporting', () => {
    expect(permForPath('/panel')).toBe('permReporting');
  });

  it('does NOT let the panel root leak into unmapped children', () => {
    // Regression guard: mapping "/panel" as a plain prefix would make every
    // unmapped child resolve to permReporting and undo default-deny for
    // backup/managers. The root must match EXACTLY.
    for (const child of ['/panel/backup', '/panel/managers', '/panel/other']) {
      expect(permForPath(child), child).toBeUndefined();
    }
  });

  it('wins on the LONGEST prefix, not the first one written', () => {
    // /panel/faqs and /panel/faq-categories are siblings, not nested.
    expect(permForPath('/panel/faqs')).toBe('permChat');
    expect(permForPath('/panel/faq-categories')).toBe('permChat');
    expect(permForPath('/panel/faq-categories/42')).toBe('permChat');
    // Sub-resource of a mapped route keeps its parent's flag.
    expect(permForPath('/panel/deposits/xyz/approve')).toBe('permFinancial');
    expect(permForPath('/panel/support/tickets/7')).toBe('permChat');
  });

  it('groups the panel nav the way the operator expects', () => {
    const of = (p: string): PermFlag | undefined => permForPath(p);
    // Finance
    for (const p of [
      '/panel/deposits',
      '/panel/withdrawals',
      '/panel/transactions',
      '/panel/payment-accounts',
      '/panel/packages',
    ]) {
      expect(of(p), p).toBe('permFinancial');
    }
    // Players
    expect(of('/panel/users')).toBe('permUsers');
    expect(of('/panel/fraud-signals')).toBe('permUsers');
    // Games
    expect(of('/panel/games')).toBe('permGames');
    // Reporting
    expect(of('/panel/reports')).toBe('permReporting');
    expect(of('/panel/dashboard')).toBe('permReporting');
    expect(of('/panel/audit-log')).toBe('permReporting');
    // Support
    expect(of('/panel/support')).toBe('permChat');
    // Settings & content
    expect(of('/panel/settings')).toBe('permSettings');
    expect(of('/panel/legal')).toBe('permSettings');
    expect(of('/panel/broadcasts')).toBe('permSettings');
  });
});
