// apps/api/src/middleware/panel-perms.test.ts
//
// Enforcement-side counterpart to packages/shared/constants/panel-perms.test.ts.
// Covers the two things the API adds on top of the shared resolver: URL
// normalization (the /api/v1 mount prefix bug that once disabled every
// permission check) and the flags /panel/auth/me reports to the panel.
import { describe, expect, it } from 'vitest';
import { permFor, adminPermissions } from './index';
import { ALL_PERM_FLAGS } from '@casino/shared/constants/panel-perms';

describe('permFor — URL normalization', () => {
  it('strips the /api/v1 mount prefix before matching', () => {
    // Regression: matching the raw url against bare /panel/... keys meant
    // startsWith NEVER matched, so permFor() always returned undefined and
    // every manager effectively held every permission.
    expect(permFor('/api/v1/panel/deposits')).toBe('permFinancial');
    expect(permFor('/panel/deposits')).toBe('permFinancial');
  });

  it('ignores the query string', () => {
    expect(permFor('/api/v1/panel/withdrawals?status=PENDING&page=2')).toBe(
      'permFinancial'
    );
    expect(permFor('/api/v1/panel/users?page=3')).toBe('permUsers');
  });

  it('still default-denies unmapped routes once normalized', () => {
    expect(permFor('/api/v1/panel/backup')).toBeUndefined();
    expect(permFor('/api/v1/panel/managers')).toBeUndefined();
  });

  it('resolves the fund special case through the mount prefix too', () => {
    expect(permFor('/api/v1/panel/users/u_1/fund')).toBe('permFinancial');
  });
});

describe('adminPermissions — what /panel/auth/me reports', () => {
  const none = {
    isSuperAdmin: false,
    permFinancial: false,
    permUsers: false,
    permReporting: false,
    permChat: false,
    permGames: false,
    permSettings: false,
  };

  it('reports exactly the flags a manager holds', () => {
    const p = adminPermissions({ ...none, permFinancial: true, permChat: true });
    expect(p).toEqual({
      permFinancial: true,
      permUsers: false,
      permReporting: false,
      permChat: true,
      permGames: false,
      permSettings: false,
    });
  });

  it('reports a manager with no flags as holding none', () => {
    for (const flag of ALL_PERM_FLAGS) {
      expect(adminPermissions(none)[flag], flag).toBe(false);
    }
  });

  it('reports a SUPER-ADMIN as holding every flag', () => {
    // adminAuthMiddleware short-circuits the check for super-admins, so the
    // nav must not hide sections the server would happily serve.
    const p = adminPermissions({ ...none, isSuperAdmin: true });
    for (const flag of ALL_PERM_FLAGS) {
      expect(p[flag], flag).toBe(true);
    }
  });

  it('agrees with permFor for every route it maps', () => {
    // The contract the panel nav relies on: if /panel/auth/me says the flag is
    // false, permFor() must also refuse that route, and vice versa.
    const manager = adminPermissions({ ...none, permUsers: true });
    const routes: Array<[string, boolean]> = [
      ['/panel/users', true],
      ['/panel/fraud-signals', true],
      ['/panel/deposits', false],
      ['/panel/settings', false],
      ['/panel', false], // panel root is permReporting, which this manager lacks
      ['/panel/backup', false], // unmapped → super-admin only
    ];
    for (const [route, allowed] of routes) {
      const flag = permFor(route);
      const uiWouldShow = flag ? manager[flag] === true : false;
      expect(uiWouldShow, route).toBe(allowed);
    }
  });
});
