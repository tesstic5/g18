import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import {
  authMiddleware,
  adminAuthMiddleware,
  requireStepUp,
  rateLimitFactory,
  applyMaturedPendingLimits,
} from '../middleware';
import { ok, AppError } from '../lib/core';
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { writeAudit } from '../lib/audit';
import { digest, validHash, payfastToken, inquirePayfast } from '../services/payfast';
import {
  loadPayfastSettings,
  safePayfastSettings,
  savePayfastSettings,
  readiness,
  providerUrl,
} from '../services/payfastSettings';
import {
  reconcilePayfast,
  sweepPayfast,
  configForPayment,
} from '../services/payfastSettlement';
import { getNumericSetting } from '../services/settings';
import { startOfDay } from '../lib/day-boundary';

const checkoutSchema = z.object({
  amount: z.number().positive().finite().max(100000000),
  packageId: z.string().max(120).optional(),
  email: z.email().max(320),
});
const idSchema = z.string().min(1).max(120);
const htmlEscape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]!
  );
export function payfastMaintenanceExempt(url: string): boolean {
  return (
    /^\/api\/v1\/payfast\/(ipn|return|status\/[^/?]+)(?:\?|$)/.test(url) ||
    /^\/api\/v1\/payfast\/callback\/[^/?]+(?:\?|$)/.test(url)
  );
}
export async function payfastRoutes(app: FastifyInstance) {
  // Scope form parsing to this plugin: do not change parsers for unrelated APIs.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16384 },
    (_req, raw, done) => {
      const entries = new URLSearchParams(String(raw));
      const body: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (Object.prototype.hasOwnProperty.call(body, k))
          return done(new AppError('PAYFAST_INVALID', 400, 'Duplicate IPN field'));
        Object.defineProperty(body, k, { value: v, enumerable: true });
      }
      done(null, body);
    }
  );
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.PAYFAST_RECONCILIATION_DISABLED === 'true'
    )
      return;
    timer = setInterval(() => {
      void sweepPayfast().catch(() =>
        app.log.warn('PayFast reconciliation unavailable')
      );
    }, 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
  app.get('/config', async (request) => {
    const c = await loadPayfastSettings();
    return ok(
      { enabled: c.enabled && readiness(c).length === 0, environment: c.environment },
      request.requestId!
    );
  });
  app.post(
    '/checkout',
    { preHandler: [authMiddleware, rateLimitFactory('deposit', (r) => r.user!.id)] },
    async (request) => {
      const c = await loadPayfastSettings();
      if (!c.enabled || readiness(c).length)
        throw new AppError('SVC_503', 503, 'PayFast checkout is not configured');
      const body = checkoutSchema.parse(request.body);
      const amount = new Decimal(body.amount);
      if (amount.decimalPlaces() > 2)
        throw new AppError(
          'GEN_VALIDATION_ERROR',
          422,
          'Use at most two decimal places'
        );
      const min = await getNumericSetting('min_deposit', 10, { allowZero: true });
      const max = await getNumericSetting('max_deposit', 100000);
      if (amount.lt(min) || amount.gt(max))
        throw new AppError(
          'GEN_VALIDATION_ERROR',
          422,
          `Deposit must be between ${min} and ${max}`
        );
      const pkg = body.packageId
        ? await prisma.depositPackage.findFirst({
            where: { id: body.packageId, isActive: true },
          })
        : null;
      if (body.packageId && (!pkg || !amount.eq(pkg.price.toString())))
        throw new AppError('GEN_VALIDATION_ERROR', 422, 'Invalid package or price');
      const userId = request.user!.id;
      const deposit = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        await applyMaturedPendingLimits(userId, tx);
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        if (user.status !== 'ACTIVE')
          throw new AppError('AUTH_ACCOUNT_SUSPENDED', 403, 'Account is not active');
        if (user.dailyDepositLimit) {
          const used = await tx.deposit.aggregate({
            where: {
              userId,
              status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] },
              createdAt: { gte: startOfDay() },
            },
            _sum: { amount: true },
          });
          if (
            amount
              .plus(used._sum.amount?.toString() ?? '0')
              .gt(user.dailyDepositLimit.toString())
          )
            throw new AppError(
              'RESP_DAILY_DEPOSIT_LIMIT',
              403,
              'Daily deposit limit reached'
            );
        }
        return tx.deposit.create({
          data: {
            userId,
            amount: amount.toFixed(2),
            paymentMethod: 'PAYFAST',
            referenceNumber: `PF-${randomUUID()}`,
            packageId: pkg?.id,
            packageCredits: pkg?.credits,
            packageBonus: pkg?.bonus,
            payfastConfigSnapshot: encryptJson(c),
            payfastCustomerIp: request.ip,
          },
        });
      });
      let token: string;
      try {
        token = await payfastToken(c, deposit.id, amount.toFixed(2));
      } catch {
        await prisma.deposit.updateMany({
          where: { id: deposit.id, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            rejectionReason: 'Checkout initialization failed',
          },
        });
        throw new AppError(
          'SVC_503',
          503,
          'Could not start PayFast checkout. Try again.'
        );
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      // A return reference selects an order but is NEVER proof of payment.
      const returnUrl = `${c.publicApiOrigin}/api/v1/payfast/return?deposit=${encodeURIComponent(deposit.id)}`;
      const fields: Record<string, string> = {
        MERCHANT_ID: c.merchantId,
        MERCHANT_NAME: c.merchantName,
        TOKEN: token,
        PROCCODE: '00',
        TXNAMT: amount.toFixed(2),
        CURRENCY_CODE: 'PKR',
        BASKET_ID: deposit.id,
        ORDER_DATE: deposit.createdAt.toISOString().slice(0, 10),
        CUSTOMER_MOBILE_NO: user.phone,
        CUSTOMER_EMAIL_ADDRESS: body.email,
        SIGNATURE: randomUUID(),
        VERSION: 'MERCHANTCART-2.0',
        TXNDESC: 'Wallet deposit',
        SUCCESS_URL: returnUrl,
        FAILURE_URL: returnUrl,
        CHECKOUT_URL: `${c.publicApiOrigin}/api/v1/payfast/ipn`,
      };
      if (c.storeId) fields.STORE_ID = c.storeId;
      const launch = randomBytes(32).toString('hex');
      await prisma.deposit.update({
        where: { id: deposit.id },
        data: {
          payfastLaunchHash: digest(launch),
          payfastLaunchExpiresAt: new Date(Date.now() + 5 * 60_000),
          payfastLaunchData: encryptJson({ action: c.checkoutUrl, fields }),
        },
      });
      // Top-level navigation to a dedicated gateway page avoids weakening the app CSP.
      return ok(
        {
          id: deposit.id,
          launchUrl: `${c.publicApiOrigin}/api/v1/payfast/launch/${launch}`,
        },
        request.requestId!
      );
    }
  );
  app.get('/launch/:token', { logLevel: 'silent' }, async (request, reply) => {
    const token = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse((request.params as { token: string }).token);
    const d = await prisma.deposit.findUnique({
      where: { payfastLaunchHash: digest(token) },
    });
    if (
      !d ||
      d.status !== 'PENDING' ||
      !d.payfastLaunchData ||
      !d.payfastLaunchExpiresAt ||
      d.payfastLaunchExpiresAt < new Date()
    )
      throw new AppError(
        'PAYFAST_EXPIRED',
        410,
        'Checkout link expired. Check your deposit status before starting another payment.'
      );
    const data = decryptJson<{ action: string; fields: Record<string, string> }>(
      d.payfastLaunchData
    );
    const claimed = await prisma.deposit.updateMany({
      where: { id: d.id, payfastLaunchHash: digest(token), status: 'PENDING' },
      data: {
        payfastLaunchHash: null,
        payfastLaunchData: null,
        payfastLaunchExpiresAt: null,
      },
    });
    if (claimed.count !== 1)
      throw new AppError('PAYFAST_EXPIRED', 410, 'Checkout link already used');
    const action = providerUrl(data.action);
    const nonce = randomBytes(18).toString('base64');
    reply.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(action).origin}; base-uri 'none'; frame-ancestors 'none'`
    );
    return reply.type('text/html').send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PayFast checkout</title></head><body><p>Opening secure payment checkout…</p><form id="checkout" method="post" action="${htmlEscape(action)}">${Object.entries(
        data.fields
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`
        )
        .join(
          ''
        )}<button type="submit">Continue to PayFast</button></form><script nonce="${nonce}">document.getElementById('checkout').submit()</script></body></html>`
    );
  });
  app.get('/return', async (request, reply) => {
    const id = idSchema.parse((request.query as { deposit?: string }).deposit);
    const d = await prisma.deposit.findUnique({ where: { id } });
    if (!d || d.paymentMethod !== 'PAYFAST')
      throw new AppError('GEN_NOT_FOUND', 404, 'Payment not found');
    const c = await configForPayment(d.payfastConfigSnapshot);
    return reply.redirect(
      `${c.frontendOrigin}/wallet?mode=deposit&payfast=${encodeURIComponent(id)}`
    );
  });
  app.get('/status/:id', { preHandler: [authMiddleware] }, async (request) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const d = await prisma.deposit.findFirst({
      where: { id, userId: request.user!.id, paymentMethod: 'PAYFAST' },
      select: { id: true, amount: true, status: true, referenceNumber: true },
    });
    if (!d) throw new AppError('GEN_NOT_FOUND', 404, 'Payment not found');
    return ok({ ...d, amount: Number(d.amount) }, request.requestId!);
  });
  // IPN POST accepts form-encoded or JSON bodies. Only authenticated inquiry can settle funds.
  app.post(
    '/ipn',
    { bodyLimit: 16384, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = z
        .object({
          basket_id: idSchema,
          err_code: z.string().min(1).max(10),
          validation_hash: z.string().length(64),
        })
        .passthrough()
        .parse(request.body);
      const d = await prisma.deposit.findUnique({ where: { id: body.basket_id } });
      if (!d || d.paymentMethod !== 'PAYFAST')
        throw new AppError('PAYFAST_INVALID', 400, 'Invalid notification');
      const c = await configForPayment(d.payfastConfigSnapshot);
      if (
        !validHash(
          body.validation_hash,
          digest(`${d.id}|${c.securedKey}|${c.merchantId}|${body.err_code}`)
        )
      )
        throw new AppError('PAYFAST_INVALID', 400, 'Invalid notification');
      // Receipt is durable in the Deposit row; background reconciliation performs
      // inquiry even if PayFast never retries after this HTTP 200 acknowledgement.
      await prisma.deposit.updateMany({
        where: { id: d.id, status: 'PENDING' },
        data: { payfastLastCheckedAt: null },
      });
      return reply.code(200).send({ received: true });
    }
  );
}

export async function payfastAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    await adminAuthMiddleware(request, reply);
    if (!request.admin!.isSuperAdmin)
      throw new AppError('AUTH_TOKEN_INVALID', 403, 'Super admin only');
    if (['POST', 'PATCH'].includes(request.method)) await requireStepUp(request);
  });
  app.addHook('onSend', async (_r, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/settings', async (request) =>
    ok(safePayfastSettings(await loadPayfastSettings()), request.requestId!)
  );
  app.patch('/settings', async (request) => {
    try {
      return ok(
        await savePayfastSettings(request.body, request.admin!, request.ip),
        request.requestId!
      );
    } catch {
      throw new AppError(
        'GEN_VALIDATION_ERROR',
        422,
        'Invalid PayFast settings. Check required fields, provider URL allowlist, and readiness checklist.'
      );
    }
  });
  app.post(
    '/test-inquiry',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z
        .object({
          basketId: idSchema,
          expectedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        })
        .parse(request.body);
      try {
        const c = await loadPayfastSettings();
        const result = await inquirePayfast(
          c,
          body.basketId,
          body.expectedAmount,
          request.ip
        );
        return ok(
          { verified: true, outcome: result.outcome, status: result.status },
          request.requestId!
        );
      } catch {
        throw new AppError(
          'PAYFAST_UNVERIFIED',
          422,
          'Inquiry did not confirm matching final payment details. Check endpoints, permissions, response fields and provider status. No balance was changed.'
        );
      }
    }
  );
  app.get('/pending', async (request) => {
    const rows = await prisma.deposit.findMany({
      where: { paymentMethod: 'PAYFAST', status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        referenceNumber: true,
        amount: true,
        createdAt: true,
        payfastLastCheckedAt: true,
        payfastLastError: true,
      },
    });
    return ok(rows, request.requestId!);
  });
  app.post(
    '/reconcile/:id',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const id = idSchema.parse((request.params as { id: string }).id);
      const result = await reconcilePayfast(id);
      await writeAudit({
        adminId: request.admin!.id,
        action: 'payfast.reconcile',
        targetType: 'deposit',
        targetId: id,
        afterState: result,
        ip: request.ip,
      });
      return ok(result, request.requestId!);
    }
  );
}
