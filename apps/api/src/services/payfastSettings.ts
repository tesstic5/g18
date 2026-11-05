import { z } from 'zod';
import { prisma } from '../db/prisma';
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { writeAuditTx } from '../lib/audit';

export const PAYFAST_SETTINGS_KEY = 'payfast_private_v1';
// Financial requests must never be directed to arbitrary admin-supplied hosts.
// Additional provider origins require an operator-controlled deployment allowlist.
export function providerUrl(value: string): string {
  const u = new URL(value);
  const allowed = (process.env.PAYFAST_ALLOWED_ORIGINS || 'https://ipguat.apps.net.pk')
    .split(',')
    .map((s) => s.trim());
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !allowed.includes(u.origin)
  )
    throw new Error('Endpoint origin is not in PAYFAST_ALLOWED_ORIGINS (HTTPS only)');
  return u.href.replace(/\/$/, '');
}
export function publicOrigin(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash
  )
    throw new Error(
      'Public URL must be an HTTPS origin without path, query or credentials'
    );
  return u.origin;
}
const field = z
  .string()
  .max(120)
  .regex(/^$|^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/);
export const payfastSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    environment: z.enum(['uat', 'production']).default('uat'),
    merchantId: z.string().max(120).default(''),
    merchantName: z.string().max(160).default(''),
    securedKey: z.string().max(2048).default(''),
    storeId: z.string().max(120).default(''),
    publicApiOrigin: z.string().max(500).default(''),
    frontendOrigin: z.string().max(500).default(''),
    checkoutTokenUrl: z
      .string()
      .max(500)
      .default('https://ipguat.apps.net.pk/Ecommerce/api/Transaction/GetAccessToken'),
    checkoutUrl: z
      .string()
      .max(500)
      .default('https://ipguat.apps.net.pk/Ecommerce/api/Transaction/PostTransaction'),
    inquiryTokenUrl: z.string().max(500).default(''),
    inquiryBaseUrl: z.string().max(500).default(''),
    inquiryTokenField: field.default('token'),
    statusField: field.default('status_code'),
    basketField: field.default('basket_id'),
    transactionField: field.default('transaction_id'),
    amountField: field.default(''),
    currencyField: field.default(''),
    successCodes: z.array(z.string().min(1).max(30)).max(10).default([]),
    terminalFailureCodes: z.array(z.string().min(1).max(30)).max(20).default([]),
    providerConfirmed: z.boolean().default(false),
  })
  .strict();
export type PayfastSettings = z.infer<typeof payfastSettingsSchema>;
export function readiness(c: PayfastSettings): string[] {
  const missing: string[] = [];
  for (const k of [
    'merchantId',
    'merchantName',
    'securedKey',
    'publicApiOrigin',
    'frontendOrigin',
    'inquiryTokenUrl',
    'inquiryBaseUrl',
    'inquiryTokenField',
    'statusField',
    'basketField',
    'transactionField',
    'amountField',
    'currencyField',
  ] as const)
    if (!c[k]) missing.push(k);
  if (!c.successCodes.length) missing.push('successCodes');
  if (c.successCodes.some((code) => c.terminalFailureCodes.includes(code)))
    missing.push('success/failure codes must not overlap');
  if (!c.providerConfirmed) missing.push('providerConfirmed');
  try {
    publicOrigin(c.publicApiOrigin);
    publicOrigin(c.frontendOrigin);
    for (const u of [
      c.checkoutTokenUrl,
      c.checkoutUrl,
      c.inquiryTokenUrl,
      c.inquiryBaseUrl,
    ])
      providerUrl(u);
  } catch {
    missing.push('valid HTTPS URLs / provider origin allowlist');
  }
  if (
    c.environment === 'production' &&
    [c.checkoutTokenUrl, c.checkoutUrl, c.inquiryTokenUrl, c.inquiryBaseUrl].some((u) =>
      /ipguat/i.test(u)
    )
  )
    missing.push('production endpoints (UAT URLs are not production)');
  return missing;
}
export async function loadPayfastSettings(): Promise<PayfastSettings> {
  const row = await prisma.setting.findUnique({ where: { key: PAYFAST_SETTINGS_KEY } });
  if (row) return payfastSettingsSchema.parse(decryptJson(String(row.value)));
  return payfastSettingsSchema.parse({
    enabled: false,
    merchantId: process.env.PAYFAST_MERCHANT_ID || '',
    securedKey: process.env.PAYFAST_SECURED_KEY || '',
    merchantName: process.env.PAYFAST_MERCHANT_NAME || '',
    storeId: process.env.PAYFAST_STORE_ID || '',
    publicApiOrigin: process.env.PAYFAST_PUBLIC_API_URL || '',
    frontendOrigin: process.env.FRONTEND_URL || '',
  });
}
export function safePayfastSettings(c: PayfastSettings) {
  const { securedKey, ...publicFields } = c;
  return { ...publicFields, hasSecuredKey: Boolean(securedKey), missing: readiness(c) };
}
export async function savePayfastSettings(
  input: unknown,
  admin: { id: string; username: string },
  ip: string
) {
  const previous = await loadPayfastSettings();
  const patch = payfastSettingsSchema.partial().parse(input);
  const c = payfastSettingsSchema.parse({
    ...previous,
    ...patch,
    securedKey: patch.securedKey || previous.securedKey,
  });
  for (const u of [
    c.checkoutTokenUrl,
    c.checkoutUrl,
    c.inquiryTokenUrl,
    c.inquiryBaseUrl,
  ])
    if (u) providerUrl(u);
  if (c.publicApiOrigin) c.publicApiOrigin = publicOrigin(c.publicApiOrigin);
  if (c.frontendOrigin) c.frontendOrigin = publicOrigin(c.frontendOrigin);
  if (c.enabled && readiness(c).length)
    throw new Error(`Cannot enable: ${readiness(c).join(', ')}`);
  await prisma.$transaction(async (tx) => {
    const encrypted = encryptJson(c);
    await tx.setting.upsert({
      where: { key: PAYFAST_SETTINGS_KEY },
      create: {
        key: PAYFAST_SETTINGS_KEY,
        value: encrypted,
        updatedBy: admin.username,
      },
      update: { value: encrypted, updatedBy: admin.username },
    });
    await writeAuditTx(tx, {
      adminId: admin.id,
      action: 'payfast.settings.update',
      targetType: 'settings',
      afterState: {
        environment: c.environment,
        enabled: c.enabled,
        secretChanged: Boolean(patch.securedKey),
        providerConfirmed: c.providerConfirmed,
      },
      ip,
    });
  });
  return safePayfastSettings(c);
}
