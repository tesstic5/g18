import { beforeEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { encryptJson } from '../lib/crypto-utils';
import { payfastSettingsSchema } from './payfastSettings';
const m = vi.hoisted(() => ({
  find: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  inquire: vi.fn(),
  credit: vi.fn(),
  lock: vi.fn(),
  referral: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../db/prisma', () => {
  const db = {
    deposit: { findUniqueOrThrow: m.find, update: m.update, updateMany: m.updateMany },
    $queryRaw: vi.fn(),
  };
  return {
    prisma: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
  };
});
vi.mock('./payfast', () => ({ inquirePayfast: m.inquire }));
vi.mock('./wallet', () => ({ applyBalanceChange: m.credit, lockWallet: m.lock }));
vi.mock('./referral', () => ({ maybeRewardReferral: m.referral }));
vi.mock('./notify', () => ({ notifyUser: m.notify }));
import { reconcilePayfast } from './payfastSettlement';
const config = () =>
  payfastSettingsSchema.parse({
    merchantId: 'old-merchant',
    securedKey: 'old-key',
    enabled: false,
  });
let row: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: 'd1',
    userId: 'u1',
    paymentMethod: 'PAYFAST',
    status: 'PENDING',
    amount: new Decimal(100),
    packageCredits: new Decimal(120),
    packageBonus: new Decimal(10),
    payfastConfigSnapshot: encryptJson(config()),
    payfastCustomerIp: '203.0.113.1',
  };
  m.find.mockImplementation(async () => ({ ...row }));
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(row, data);
    return row;
  });
  m.notify.mockResolvedValue(undefined);
  m.inquire.mockResolvedValue({
    transactionId: 't1',
    basketId: 'd1',
    amount: '100.00',
    currency: 'PKR',
    status: '00',
    outcome: 'paid',
  });
});
describe('PayFast settlement', () => {
  it('credits the saved real/bonus values only after independent inquiry', async () => {
    expect((await reconcilePayfast('d1')).status).toBe('COMPLETED');
    expect(m.credit).toHaveBeenCalledTimes(2);
    expect(m.credit.mock.calls[0]![2].toString()).toBe('120');
    expect(m.credit.mock.calls[1]![2].toString()).toBe('10');
    expect(m.inquire.mock.calls[0]![0]).toMatchObject({
      merchantId: 'old-merchant',
      securedKey: 'old-key',
      enabled: false,
    });
  });
  it('does not credit duplicate completed payments', async () => {
    row.status = 'COMPLETED';
    await reconcilePayfast('d1');
    expect(m.inquire).not.toHaveBeenCalled();
    expect(m.credit).not.toHaveBeenCalled();
  });
  it('rechecks the locked state after inquiry to handle racing reconcilers', async () => {
    m.inquire.mockImplementation(async () => {
      row.status = 'COMPLETED';
      return { outcome: 'paid' };
    });
    await reconcilePayfast('d1');
    expect(m.credit).not.toHaveBeenCalled();
  });
  it('leaves ambiguous/failed inquiries pending without credit', async () => {
    m.inquire.mockRejectedValue(new Error('unverified'));
    expect((await reconcilePayfast('d1')).status).toBe('PENDING');
    expect(m.credit).not.toHaveBeenCalled();
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1', status: 'PENDING' } })
    );
  });
  it('releases a provider-confirmed final failure without credit', async () => {
    m.inquire.mockResolvedValue({ outcome: 'failed' });
    expect((await reconcilePayfast('d1')).status).toBe('REJECTED');
    expect(m.credit).not.toHaveBeenCalled();
  });
  it('fails closed on legacy orders with no credential snapshot', async () => {
    row.payfastConfigSnapshot = null;
    expect((await reconcilePayfast('d1')).status).toBe('PENDING');
    expect(m.inquire).not.toHaveBeenCalled();
    expect(m.credit).not.toHaveBeenCalled();
  });
});
