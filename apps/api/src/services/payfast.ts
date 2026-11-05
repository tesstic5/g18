import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { providerUrl, type PayfastSettings } from './payfastSettings';
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function validHash(actual: string, expected: string): boolean {
  return (
    /^[a-f0-9]{64}$/i.test(actual) &&
    /^[a-f0-9]{64}$/i.test(expected) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  );
}
async function gatewayJson(url: string, init: RequestInit) {
  const response = await fetch(providerUrl(url), {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('PayFast request failed');
  const raw = await response.text();
  if (raw.length > 100000) throw new Error('PayFast response too large');
  return JSON.parse(raw) as unknown;
}
const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'MerchantCheckout/2.0',
};
export async function payfastToken(c: PayfastSettings, basket: string, amount: string) {
  const data = z
    .object({
      ACCESS_TOKEN: z.string().min(1).max(10000),
      MERCHANT_ID: z.union([z.string(), z.number()]).optional(),
    })
    .parse(
      await gatewayJson(c.checkoutTokenUrl, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          MERCHANT_ID: c.merchantId,
          SECURED_KEY: c.securedKey,
          BASKET_ID: basket,
          TXNAMT: amount,
          CURRENCY_CODE: 'PKR',
        }),
      })
    );
  if (data.MERCHANT_ID !== undefined && String(data.MERCHANT_ID) !== c.merchantId)
    throw new Error('Merchant mismatch');
  return data.ACCESS_TOKEN;
}
export function readField(data: unknown, path: string): unknown {
  if (!path) return undefined;
  let current = data;
  for (const part of path.split('.')) {
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export interface VerifiedPayment {
  transactionId: string;
  basketId: string;
  amount: string;
  currency: string;
  status: string;
  outcome: 'paid' | 'failed';
}
export function verifyInquiryResponse(
  c: PayfastSettings,
  data: unknown,
  basket: string,
  expectedAmount: string
): VerifiedPayment {
  const str = (path: string) => {
    const value = readField(data, path);
    // Status codes must stay strings: numeric zero loses significant zeroes.
    if (typeof value !== 'string' || !value || value.length > 200)
      throw new Error('Incomplete inquiry response');
    return value;
  };
  const result = {
    transactionId: str(c.transactionField),
    basketId: str(c.basketField),
    amount: str(c.amountField),
    currency: str(c.currencyField),
    status: str(c.statusField),
  };
  if (
    result.basketId !== basket ||
    result.currency !== 'PKR' ||
    !/^\d+(\.\d{1,2})?$/.test(result.amount) ||
    !new Decimal(result.amount).eq(expectedAmount)
  )
    throw new Error('Inquiry details mismatch');
  if (c.successCodes.includes(result.status)) return { ...result, outcome: 'paid' };
  if (c.terminalFailureCodes.includes(result.status))
    return { ...result, outcome: 'failed' };
  throw new Error('Payment is not final');
}
export async function inquirePayfast(
  c: PayfastSettings,
  basket: string,
  expectedAmount: string,
  customerIp: string
): Promise<VerifiedPayment> {
  const tokenResponse = await gatewayJson(c.inquiryTokenUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      merchant_id: c.merchantId,
      secured_key: c.securedKey,
      grant_type: 'client_credentials',
      customer_ip: customerIp,
    }),
  });
  const token = z
    .string()
    .min(1)
    .max(10000)
    .parse(readField(tokenResponse, c.inquiryTokenField));
  const data = await gatewayJson(
    `${c.inquiryBaseUrl.replace(/\/$/, '')}/transaction/basket_id/${encodeURIComponent(basket)}`,
    { method: 'GET', headers: { ...headers, Authorization: `Bearer ${token}` } }
  );
  return verifyInquiryResponse(c, data, basket, expectedAmount);
}
