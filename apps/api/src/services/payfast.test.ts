import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  digest,
  validHash,
  payfastToken,
  verifyInquiryResponse,
  readField,
  inquirePayfast,
} from './payfast';
import {
  payfastSettingsSchema,
  readiness,
  providerUrl,
  publicOrigin,
  safePayfastSettings,
} from './payfastSettings';
const config = () =>
  payfastSettingsSchema.parse({
    merchantId: '102',
    securedKey: 'secret',
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
const paid = {
  basket_id: 'dep1',
  transaction_id: 'txn1',
  merchant_amount: '100.00',
  transaction_currency: 'PKR',
  status_code: '00',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('PayFast verified payment contract', () => {
  it('matches the documented SHA256 vector', () => {
    expect(digest('BAS-01|jdnkaabcks|102|000')).toBe(
      'e8192a7554dd699975adf39619c703a492392edf5e416a61e183866ecdf6a2a2'
    );
  });
  it('rejects malformed hashes on either side without throwing', () => {
    expect(validHash(digest('a'), digest('a'))).toBe(true);
    expect(validHash('g'.repeat(64), digest('a'))).toBe(false);
    expect(validHash(digest('a'), 'bad')).toBe(false);
  });
  it('requires a complete provider contract before activation', () => {
    expect(readiness(payfastSettingsSchema.parse({})).length).toBeGreaterThan(0);
    expect(readiness(config())).toEqual([]);
    expect(readiness({ ...config(), environment: 'production' })).toContain(
      'production endpoints (UAT URLs are not production)'
    );
  });
  it('never returns a saved secret to the panel', () => {
    expect(safePayfastSettings(config())).not.toHaveProperty('securedKey');
    expect(safePayfastSettings(config()).hasSecuredKey).toBe(true);
  });
  it.each([
    'http://ipguat.apps.net.pk/token',
    'https://127.0.0.1/token',
    'https://evil.example/token',
    'https://ipguat.apps.net.pk@evil.example/token',
    'https://ipguat.apps.net.pk/token?secret=x',
  ])('rejects unsafe endpoint %s', (url) => expect(() => providerUrl(url)).toThrow());
  it('rejects public origin paths and credentials', () => {
    expect(() => publicOrigin('https://api.example.com/api')).toThrow();
    expect(() => publicOrigin('https://user@api.example.com')).toThrow();
  });
  it('accepts a matching final payment from authenticated inquiry', () => {
    expect(verifyInquiryResponse(config(), paid, 'dep1', '100')).toMatchObject({
      outcome: 'paid',
      transactionId: 'txn1',
    });
  });
  it.each([
    { merchant_amount: '1.00' },
    { transaction_currency: 'USD' },
    { basket_id: 'other' },
    { transaction_id: '' },
    { status_code: '001' },
    { status_code: 0 },
    { merchant_amount: undefined },
  ])('fails closed for incomplete/mismatched inquiry %j', (override) => {
    expect(() =>
      verifyInquiryResponse(config(), { ...paid, ...override }, 'dep1', '100')
    ).toThrow();
  });
  it('supports documented nested response field paths', () => {
    expect(readField({ data: { amount: '100' } }, 'data.amount')).toBe('100');
    expect(readField({}, '__proto__')).toBeUndefined();
  });
  it('classifies only explicitly configured final failures', () => {
    expect(
      verifyInquiryResponse(
        { ...config(), terminalFailureCodes: ['FINAL_FAILED'] },
        { ...paid, status_code: 'FINAL_FAILED' },
        'dep1',
        '100'
      ).outcome
    ).toBe('failed');
    expect(() =>
      verifyInquiryResponse(config(), { ...paid, status_code: '002' }, 'dep1', '100')
    ).toThrow();
  });
  it('sends amount-bound hosted token request and validates response types', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ACCESS_TOKEN: 'token', MERCHANT_ID: '102' }),
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await payfastToken(config(), 'dep1', '100.00')).toBe('token');
    expect(fetcher.mock.calls[0]![1].body.get('TXNAMT')).toBe('100.00');
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
    fetcher.mockResolvedValue({ ok: true, text: async () => '{"ACCESS_TOKEN":42}' });
    await expect(payfastToken(config(), 'dep1', '100.00')).rejects.toThrow();
  });
  it('authenticates inquiry and looks up the server basket, not client transaction fields', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '{"token":"auth-token"}' })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(paid) });
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await inquirePayfast(config(), 'dep1', '100.00', '203.0.113.1')).outcome
    ).toBe('paid');
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://ipguat.apps.net.pk/transaction/basket_id/dep1'
    );
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe('Bearer auth-token');
  });
});
