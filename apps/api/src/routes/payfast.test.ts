import Fastify, { type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../services/payfast';
import { encryptJson } from '../lib/crypto-utils';
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  user: vi.fn(),
  aggregate: vi.fn(),
  pkg: vi.fn(),
  token: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  reconcile: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../db/prisma', () => {
  const db = {
    deposit: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
      aggregate: mocks.aggregate,
    },
    user: { findUniqueOrThrow: mocks.user },
    depositPackage: { findFirst: mocks.pkg },
    $queryRaw: vi.fn(),
  };
  return {
    prisma: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
  };
});
vi.mock('../middleware', () => ({
  authMiddleware: async (r: { user: unknown }) => {
    r.user = { id: 'u1' };
  },
  adminAuthMiddleware: async (r: {
    admin: unknown;
    headers: Record<string, string>;
  }) => {
    r.admin = {
      id: 'admin1',
      username: 'admin',
      isSuperAdmin: r.headers['x-manager'] !== 'true',
    };
  },
  rateLimitFactory: () => async () => {},
  requireStepUp: vi.fn(),
  applyMaturedPendingLimits: vi.fn(),
}));
vi.mock('../services/settings', () => ({
  getNumericSetting: async (_key: string, fallback: number) => fallback,
}));
vi.mock('../services/payfast', async (original) => ({
  ...(await original<typeof import('../services/payfast')>()),
  payfastToken: mocks.token,
}));
vi.mock('../services/payfastSettings', async (original) => ({
  ...(await original<typeof import('../services/payfastSettings')>()),
  loadPayfastSettings: mocks.load,
  savePayfastSettings: mocks.save,
}));
vi.mock('../services/payfastSettlement', () => ({
  reconcilePayfast: mocks.reconcile,
  sweepPayfast: vi.fn(),
  configForPayment: async () => mocks.load(),
}));
vi.mock('../lib/audit', () => ({ writeAudit: mocks.audit }));
import { payfastRoutes, payfastAdminRoutes, payfastMaintenanceExempt } from './payfast';
import { payfastSettingsSchema } from '../services/payfastSettings';
const config = () =>
  payfastSettingsSchema.parse({
    enabled: true,
    merchantId: '102',
    securedKey: 'key',
    merchantName: 'Test',
    publicApiOrigin: 'https://api.example.com',
    frontendOrigin: 'https://example.com',
    inquiryTokenUrl: 'https://ipguat.apps.net.pk/token',
    inquiryBaseUrl: 'https://ipguat.apps.net.pk',
    amountField: 'merchant_amount',
    currencyField: 'transaction_currency',
    successCodes: ['00'],
    providerConfirmed: true,
  });
const deposit = () => ({
  id: 'dep1',
  userId: 'u1',
  paymentMethod: 'PAYFAST',
  amount: new (class {
    toString() {
      return '100.00';
    }
  })(),
  payfastConfigSnapshot: 'snapshot',
  status: 'PENDING',
  createdAt: new Date('2026-10-16T00:00:00Z'),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PAYFAST_RECONCILIATION_DISABLED', 'true');
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.load.mockResolvedValue(config());
  mocks.findUnique.mockResolvedValue(deposit());
  mocks.create.mockResolvedValue(deposit());
  mocks.user.mockResolvedValue({
    id: 'u1',
    phone: '03001234567',
    status: 'ACTIVE',
    dailyDepositLimit: null,
  });
  mocks.token.mockResolvedValue('token');
  mocks.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mocks.pkg.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
async function inject(options: InjectOptions, admin = false) {
  const app = Fastify();
  await app.register(admin ? payfastAdminRoutes : payfastRoutes);
  try {
    return await app.inject(options);
  } finally {
    await app.close();
  }
}
describe('PayFast hosted integration', () => {
  const ipn = () => ({
    basket_id: 'dep1',
    err_code: '000',
    validation_hash: digest('dep1|key|102|000'),
    merchant_amount: '2.00',
    transaction_amount: '3.98',
    transaction_id: 'untrusted',
  });
  it('acknowledges documented form IPN without crediting untrusted fields', async () => {
    const res = await inject({
      method: 'POST',
      url: '/ipn',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(ipn()).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it('accepts JSON IPN', async () =>
    expect(
      (await inject({ method: 'POST', url: '/ipn', payload: ipn() })).statusCode
    ).toBe(200));
  it('rejects duplicate form fields', async () => {
    const res = await inject({
      method: 'POST',
      url: '/ipn',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(ipn()).toString() + '&basket_id=other',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it('rejects invalid hashes and GET notifications', async () => {
    expect(
      (
        await inject({
          method: 'POST',
          url: '/ipn',
          payload: { ...ipn(), validation_hash: '0'.repeat(64) },
        })
      ).statusCode
    ).toBe(400);
    expect((await inject({ method: 'GET', url: '/ipn' })).statusCode).toBe(404);
  });
  it('continues accepting IPNs when new checkouts are disabled', async () => {
    mocks.load.mockResolvedValue({ ...config(), enabled: false });
    expect(
      (await inject({ method: 'POST', url: '/ipn', payload: ipn() })).statusCode
    ).toBe(200);
  });
  it('creates a server-side launch link without returning form fields or secured key', async () => {
    const res = await inject({
      method: 'POST',
      url: '/checkout',
      payload: { amount: 100, email: 'a@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.launchUrl).toMatch(
      /^https:\/\/api.example.com\/api\/v1\/payfast\/launch\/[a-f0-9]{64}$/
    );
    expect(res.json().data).not.toHaveProperty('fields');
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('blocks incomplete configuration before creating an order', async () => {
    mocks.load.mockResolvedValue({ ...config(), amountField: '' });
    expect(
      (
        await inject({
          method: 'POST',
          url: '/checkout',
          payload: { amount: 100, email: 'a@example.com' },
        })
      ).statusCode
    ).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects package mismatch', async () => {
    expect(
      (
        await inject({
          method: 'POST',
          url: '/checkout',
          payload: { amount: 100, email: 'a@example.com', packageId: 'missing' },
        })
      ).statusCode
    ).toBe(422);
  });
  it('enforces daily limit under the creation transaction', async () => {
    mocks.user.mockResolvedValue({
      id: 'u1',
      status: 'ACTIVE',
      dailyDepositLimit: '50.00',
    });
    expect(
      (
        await inject({
          method: 'POST',
          url: '/checkout',
          payload: { amount: 100, email: 'a@example.com' },
        })
      ).statusCode
    ).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('releases a never-launched order after token failure', async () => {
    mocks.token.mockRejectedValue(new Error('gateway offline'));
    expect(
      (
        await inject({
          method: 'POST',
          url: '/checkout',
          payload: { amount: 100, email: 'a@example.com' },
        })
      ).statusCode
    ).toBe(503);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) })
    );
  });
  it('renders a narrowly scoped launch CSP and escapes provider form values', async () => {
    mocks.findUnique.mockResolvedValue({
      ...deposit(),
      payfastLaunchExpiresAt: new Date(Date.now() + 10000),
      payfastLaunchData: encryptJson({
        action: config().checkoutUrl,
        fields: { TXNDESC: '"><script>bad()</script>' },
      }),
    });
    const res = await inject({ method: 'GET', url: '/launch/' + 'a'.repeat(64) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain(
      'form-action https://ipguat.apps.net.pk'
    );
    expect(res.body).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(res.body).not.toContain('<script>bad()');
  });
  it('rejects expired launches', async () => {
    expect(
      (await inject({ method: 'GET', url: '/launch/' + 'a'.repeat(64) })).statusCode
    ).toBe(410);
  });
  it('returns to a durable order status without crediting', async () => {
    const res = await inject({
      method: 'GET',
      url: '/return?deposit=dep1&err_code=000',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      'https://example.com/wallet?mode=deposit&payfast=dep1'
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it('ownership-gates player order status', async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect((await inject({ method: 'GET', url: '/status/other' })).statusCode).toBe(
      404
    );
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other', userId: 'u1', paymentMethod: 'PAYFAST' },
      })
    );
  });
  it('only exempts settlement/return/status, not checkout, from maintenance', () => {
    for (const path of ['ipn', 'return?deposit=x', 'status/dep1'])
      expect(payfastMaintenanceExempt('/api/v1/payfast/' + path)).toBe(true);
    expect(payfastMaintenanceExempt('/api/v1/payfast/checkout')).toBe(false);
    expect(payfastMaintenanceExempt('/api/v1/payfast/launch/secret')).toBe(false);
  });
  it('denies non-super admins gateway configuration access', async () => {
    expect(
      (
        await inject(
          { method: 'GET', url: '/settings', headers: { 'x-manager': 'true' } },
          true
        )
      ).statusCode
    ).toBe(403);
  });
  it('masks secrets on admin reads', async () => {
    const res = await inject({ method: 'GET', url: '/settings' }, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty('securedKey');
  });
});
