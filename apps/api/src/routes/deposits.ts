// apps/api/src/routes/deposits.ts — presigned upload + manual deposit flow (v7 §5, v4)
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { MinioClient, MinioPublicClient } from '../db/minio';
import { depositCreateSchema } from '@casino/shared/validators';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { getJwtPublicKey } from '../lib/jwt-keys';
import { JWT_ISSUER_ADMIN, JWT_ROLE_ADMIN } from '../lib/jwt-claims';
import {
  authMiddleware,
  rateLimitFactory,
  applyMaturedPendingLimits,
} from '../middleware';
import { prisma } from '../db/prisma';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { getNumericSetting } from '../services/settings';
import { checkDepositFraud } from '../services/fraud';
import { money } from '@casino/shared/utils/money';
import { startOfDay } from '../lib/day-boundary';

export async function depositRoutes(app: FastifyInstance) {
  // GET /deposits/packages — the top-up packages shown on the deposit page.
  // Public to logged-in users; inactive packages are never exposed.
  app.get('/packages', async (request) => {
    const rows = await prisma.depositPackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
      select: {
        id: true,
        name: true,
        price: true,
        credits: true,
        bonus: true,
        badge: true,
        description: true,
      },
    });
    return ok(
      rows.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.price),
        credits: Number(p.credits),
        bonus: Number(p.bonus),
        total: Number(p.credits) + Number(p.bonus),
        badge: p.badge,
        description: p.description,
      })),
      request.requestId!
    );
  });

  // GET /deposits/accounts — active manual payment accounts the admin added
  // (public to logged-in users; only the fields needed to pay, D-061)
  app.get('/accounts', { preHandler: [authMiddleware] }, async (request) => {
    const accounts = await prisma.manualPaymentAccount.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, type: true, label: true, accountDetails: true },
    });
    return ok(accounts, request.requestId!);
  });

  // POST /deposits/upload-url — presigned PUT (5 min), direct to MinIO (v7 §5)
  app.post(
    '/upload-url',
    { preHandler: [authMiddleware, rateLimitFactory('upload', (r) => r.user!.id)] },
    async (request) => {
      const body = request.body as {
        fileName?: string;
        fileType?: string;
        fileSize?: number;
      };
      if (
        !body?.fileType ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(body.fileType)
      ) {
        throw new AppError(
          ERROR_CODES.FIN_INVALID_FILE_TYPE,
          422,
          'Please upload a JPG, PNG, or WebP image'
        );
      }
      if (!body.fileSize || body.fileSize > 5 * 1024 * 1024) {
        throw new AppError(
          ERROR_CODES.FIN_FILE_TOO_LARGE,
          422,
          'Image must be under 5MB'
        );
      }
      const ext = body.fileType.split('/')[1];
      const objectKey = `deposits/${request.user!.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const bucket = process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs';
      // Sign with the PUBLIC client: this URL goes to the user's browser, so it
      // must name a host the browser can resolve. Signing with the internal
      // Docker hostname (http://minio:9000) produced ERR_NAME_NOT_RESOLVED and
      // the upload failed silently.
      let presignedUrl: string;
      try {
        presignedUrl = await MinioPublicClient.presignedPutObject(
          bucket,
          objectKey,
          5 * 60
        );
      } catch (e) {
        request.log.error({ err: e }, 'presign failed');
        throw new AppError(
          'SVC_503',
          503,
          'Image uploads are temporarily unavailable. You can still submit the deposit and send the proof to support.'
        );
      }
      return ok({ presignedUrl, objectKey }, request.requestId!);
    }
  );

  // POST /deposits/upload — MULTIPART RELAY fallback: browser → API → MinIO.
  // (correction #8, 2026-08-21: deposit proofs sometimes fail on the presigned
  // path because the browser cannot reach S3_PUBLIC_ENDPOINT — domain mapped to
  // :9000, path-mapped proxy, DNS, CORS… whichever link breaks, the screenshot
  // dies and the UI showed a generic message. The relay has NO such dependency:
  // the browser only talks to the API domain it already reached for login, and
  // the API stores the object with the INTERNAL Minio client. The web client
  // tries the presigned PUT first (cheaper) and falls back here automatically.)
  app.post(
    '/upload',
    { preHandler: [authMiddleware, rateLimitFactory('upload', (r) => r.user!.id)] },
    async (request) => {
      const file = await request.file();
      if (!file)
        throw new AppError(ERROR_CODES.FIN_INVALID_FILE_TYPE, 422, 'No file attached');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        throw new AppError(
          ERROR_CODES.FIN_INVALID_FILE_TYPE,
          422,
          'Please upload a JPG, PNG, or WebP image'
        );
      }
      const buf = await file.toBuffer(); // ≤5MB via global multipart limits
      if (!buf.length) {
        throw new AppError(ERROR_CODES.FIN_INVALID_FILE_TYPE, 422, 'Empty file');
      }
      // Magic-byte sniff — extension and declared mimetype are attacker-controlled.
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isPng =
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const isWebp =
        buf.length > 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP';
      if (!isJpeg && !isPng && !isWebp) {
        throw new AppError(
          ERROR_CODES.FIN_INVALID_FILE_TYPE,
          422,
          'That file is not really an image'
        );
      }
      if (buf.length > 5 * 1024 * 1024) {
        throw new AppError(
          ERROR_CODES.FIN_FILE_TOO_LARGE,
          422,
          'Image must be under 5MB'
        );
      }
      const ext = file.mimetype.split('/')[1];
      const objectKey = `deposits/${request.user!.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const bucket = process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs';
      try {
        await MinioClient.putObject(bucket, objectKey, buf, buf.length, {
          'Content-Type': file.mimetype,
        });
      } catch (e) {
        request.log.error({ err: e }, 'relay upload to MinIO failed');
        throw new AppError(
          'SVC_503',
          503,
          'Storage write failed — try again in a minute'
        );
      }
      return ok({ objectKey }, request.requestId!);
    }
  );

  // POST /deposits/create — manual deposit with proof object key + sender account
  app.post(
    '/create',
    { preHandler: [authMiddleware, rateLimitFactory('deposit', (r) => r.user!.id)] },
    async (request) => {
      const body = depositCreateSchema.parse(request.body);
      const userId = request.user!.id;
      // H-07: the proof object must EXIST under this user's own uploads prefix
      // and stay within the size the presign contract advertised. Before this,
      // any caller could attach someone else's proof (or a bare, nonexistent
      // key) to their deposit, and the presigned PUT carried no enforced
      // content-length — a giant or empty object would sail straight into the
      // review queue.
      if (!body.proofObjectKey.startsWith(`deposits/${userId}/`))
        throw new AppError(
          ERROR_CODES.FIN_DEPOSIT_PROOF_REQUIRED,
          422,
          'Invalid proof upload — please re-upload your receipt'
        );
      const proofBucket = process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs';
      const stat = await MinioClient.statObject(proofBucket, body.proofObjectKey).catch(
        () => null
      );
      if (!stat)
        throw new AppError(
          ERROR_CODES.FIN_DEPOSIT_PROOF_REQUIRED,
          422,
          'Proof of payment not found — please upload it again before submitting'
        );
      const MAX_PROOF_BYTES = 5 * 1024 * 1024;
      if (stat.size > MAX_PROOF_BYTES)
        throw new AppError(
          ERROR_CODES.FIN_FILE_TOO_LARGE,
          422,
          'Proof of payment is too large (max 5 MB)'
        );
      const amount = money(body.amount);
      const minDeposit = money(
        await getNumericSetting('min_deposit', 10, { allowZero: true })
      );
      if (amount.lt(minDeposit)) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          `Minimum deposit is ${minDeposit.toFixed(2)}`
        );
      }
      // v1.4.1: admin-controlled global CAP per deposit request.
      const maxDeposit = money(await getNumericSetting('max_deposit', 100000));
      if (amount.gt(maxDeposit)) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          `Maximum deposit is ${maxDeposit.toFixed(2)}`
        );
      }
      const referenceNumber = `DEP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      // Resolve the chosen package (if any) and make the amount match its price —
      // the client must not be able to claim a big package for a small payment.
      const pkg = body.packageId
        ? await prisma.depositPackage.findFirst({
            where: { id: body.packageId, isActive: true },
          })
        : null;
      if (body.packageId && !pkg) {
        throw new AppError(
          ERROR_CODES.GEN_NOT_FOUND,
          404,
          'That package is no longer available'
        );
      }
      if (pkg && !amount.eq(pkg.price.toString())) {
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          `This package costs ${pkg.price.toString()} — the amount must match`
        );
      }

      // Serialize deposit-limit checks per user. Two simultaneous requests must
      // not both observe room under the limit and create deposits above it.
      const deposit = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        // H-17: a matured cooling-off limit change applies here (the row is locked).
        await applyMaturedPendingLimits(userId, tx);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { dailyDepositLimit: true },
        });
        if (user.dailyDepositLimit) {
          const start = startOfDay();
          const used = await tx.deposit.aggregate({
            where: {
              userId,
              status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] },
              createdAt: { gte: start },
            },
            _sum: { amount: true },
          });
          const nextTotal = money(used._sum.amount ?? 0).plus(amount);
          if (nextTotal.gt(user.dailyDepositLimit.toString())) {
            throw new AppError(
              ERROR_CODES.RESP_DAILY_DEPOSIT_LIMIT,
              403,
              'Daily deposit limit reached. Try again tomorrow.'
            );
          }
        }

        return tx.deposit.create({
          data: {
            userId,
            amount: amount.toFixed(2),
            // Snapshot both real credits and bonus as promised now. Later package
            // edits cannot change an already-paid order.
            packageId: pkg?.id,
            packageCredits: pkg ? pkg.credits.toFixed(2) : undefined,
            packageBonus: pkg ? pkg.bonus.toFixed(2) : undefined,
            paymentMethod: body.paymentMethod,
            accountLabel: body.accountLabel,
            accountDetails: (body.accountDetails ?? {}) as never,
            senderAccount: body.senderAccount,
            proofObjectKey: body.proofObjectKey,
            referenceNumber,
          },
        });
      });
      // Side effects AFTER the row is committed. A throw here used to 500
      // "An unexpected error occurred" while admin already had the request
      // (checkDepositFraud was called without an import → ReferenceError).
      try {
        emitAdmin('new-deposit', {
          kind: 'deposit',
          at: Date.now(),
          userId: shortId(request.user!.id),
          amount: Number(deposit.amount),
          method: deposit.paymentMethod,
          status: deposit.status,
        });
      } catch (e) {
        request.log.error({ err: e }, 'admin feed new-deposit failed');
      }
      void checkDepositFraud(userId, {
        senderAccount: body.senderAccount,
        amount: Number(deposit.amount),
        depositId: deposit.id,
      }).catch((e) => request.log.error({ err: e }, 'deposit fraud check failed'));
      return ok(
        { id: deposit.id, referenceNumber, status: deposit.status },
        request.requestId!
      );
    }
  );

  // GET /deposits/proof/:key — stream a stored proof image (owner player or admin)
  app.get('/proof/*', { preHandler: [proofAuthMiddleware] }, async (request, reply) => {
    const key = (request.params as { '*': string })['*'];
    if (!key || key.length > 500 || key.includes('..')) {
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Proof not found');
    }
    // D-078 (security): ownership check — a player may only view THEIR OWN
    // proof (Deposit row must tie the key to the user). Admins may view any.
    if (!request.user!.isAdmin) {
      const owned = await prisma.deposit.findFirst({
        where: { userId: request.user!.id, proofObjectKey: key },
        select: { id: true },
      });
      if (!owned) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Proof not found');
    }
    try {
      const stream = await MinioClient.getObject(
        process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs',
        key
      );
      const contentType = key.toLowerCase().endsWith('.png')
        ? 'image/png'
        : key.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
      reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'private, max-age=300');
      return reply.send(stream);
    } catch {
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Proof not found');
    }
  });

  // GET /deposits — player's deposits
  app.get('/', { preHandler: [authMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, parseInt(q.page || '1'));
    const rows = await prisma.deposit.findMany({
      where: {
        userId: request.user!.id,
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * 20,
      take: 20,
    });
    return ok(rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('payfast')))), request.requestId!);
  });
}

/** D-078: auth for proof images — admin signed URL, admin cookie, OR player bearer. */
async function proofAuthMiddleware(
  request: Parameters<typeof authMiddleware>[0],
  reply: Parameters<typeof authMiddleware>[1]
): Promise<void> {
  const requestedKey = (request.params as { '*'?: string })['*'] ?? '';
  // 1) One-click signed URL minted by the permission-gated panel list
  //    (v1.3.2): key-bound, 10-minute RS256 JWT — needs no cookie/session
  //    state, so the admin's <a target="_blank"> works in every deployment.
  const pt = (request.query as { pt?: string })?.pt;
  if (pt) {
    try {
      const payload = jwt.verify(pt, getJwtPublicKey(), {
        algorithms: ['RS256'],
        issuer: JWT_ISSUER_ADMIN,
      }) as { scope?: string; k?: string };
      if (payload.scope !== 'deposit-proof' || payload.k !== requestedKey)
        throw new Error('proof token mismatch');
      request.user = { id: 'admin-signed-url', role: 'admin', isAdmin: true };
      return;
    } catch {
      /* invalid/expired token — fall through to the session-based checks */
    }
  }
  const cookies = (request.cookies ?? {}) as Record<string, string>;
  if (cookies.admin_token) {
    try {
      // NOTE: this route lives OUTSIDE /panel, so the full adminAuthMiddleware
      // would default-deny every non-super manager (the path has no PERM_ROUTE
      // entry) even when the token is valid. Verify the admin JWT directly and
      // gate on the deposit-review permission instead: viewing proofs is part
      // of reviewing deposits → permFinancial (super-admins always pass).
      const payload = jwt.verify(cookies.admin_token, getJwtPublicKey(), {
        algorithms: ['RS256'],
        issuer: JWT_ISSUER_ADMIN,
      }) as { sub: string; role?: string };
      if (payload.role !== JWT_ROLE_ADMIN) throw new Error('not an admin token');
      const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
      if (admin && (admin.isSuperAdmin || admin.permFinancial)) {
        request.user = { id: admin.id, role: 'admin', isAdmin: true };
        return;
      }
      // A real admin WITHOUT the finance permission must not read proofs.
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Proof not found');
    } catch (e) {
      if (e instanceof AppError) throw e;
      /* fall through to player auth */
    }
  }
  await authMiddleware(request, reply);
  request.user = { ...request.user!, isAdmin: false };
}
