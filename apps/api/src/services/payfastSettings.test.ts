import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '../lib/crypto-utils';
const m = vi.hoisted(() => ({ find: vi.fn(), upsert: vi.fn(), audit: vi.fn() }));
vi.mock('../db/prisma', () => ({
  prisma: {
    setting: { findUnique: m.find },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ setting: { upsert: m.upsert } }),
  },
}));
vi.mock('../lib/audit', () => ({ writeAuditTx: m.audit }));
import { savePayfastSettings, payfastSettingsSchema } from './payfastSettings';
const admin = { id: 'a1', username: 'admin' };
beforeEach(() => {
  vi.clearAllMocks();
  m.find.mockResolvedValue({
    value: encryptJson(payfastSettingsSchema.parse({ securedKey: 'old-key' })),
  });
});
describe('PayFast admin secret storage', () => {
  it('encrypts settings and redacts the secret from response and audit', async () => {
    const result = await savePayfastSettings(
      { securedKey: 'new-key', merchantId: '102' },
      admin,
      '127.0.0.1'
    );
    expect(result).not.toHaveProperty('securedKey');
    const saved = m.upsert.mock.calls[0]![0].create.value;
    expect(saved).not.toContain('new-key');
    expect(decryptJson<{ securedKey: string }>(saved).securedKey).toBe('new-key');
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain('new-key');
  });
  it('preserves an existing key when blank is submitted', async () => {
    await savePayfastSettings({ securedKey: '' }, admin, '127.0.0.1');
    expect(
      decryptJson<{ securedKey: string }>(m.upsert.mock.calls[0]![0].create.value)
        .securedKey
    ).toBe('old-key');
  });
  it('refuses activation with incomplete verification settings', async () => {
    await expect(
      savePayfastSettings({ enabled: true }, admin, '127.0.0.1')
    ).rejects.toThrow();
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it('refuses unsafe endpoint origins', async () => {
    await expect(
      savePayfastSettings(
        { inquiryTokenUrl: 'https://evil.example/token' },
        admin,
        '127.0.0.1'
      )
    ).rejects.toThrow();
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
