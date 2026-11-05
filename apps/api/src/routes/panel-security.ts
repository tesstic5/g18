import { rotatePayfastSecrets } from '../services/payfastRotation';
// apps/api/src/routes/panel-security.ts — panel security surface.
//
//   POST /panel/auth/reauth                        step-up proof (password)
//   GET  /panel/monitoring/overview                watchpage: is anything wrong?
//   GET  /panel/monitoring/alerts                  persisted alerts
//   PATCH /panel/monitoring/alerts/:id             acknowledge / resolve
//   POST /panel/monitoring/watchdog/run            run the checks now
//   POST /panel/maintenance/rotate-encryption-key  re-encrypt with a new key
//
// Everything here is additive: it changes no existing behaviour and, with
// nothing configured, the endpoints still answer (monitoring) or refuse
// safely (rotation without a key).

import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { writeAudit } from '../lib/audit';
import { prisma } from '../db/prisma';
import { redis } from '../db/redis';
import Decimal from 'decimal.js';
import { adminAuthMiddleware, rateLimit, requireStepUp } from '../middleware';
import { getNumericSetting, getSetting } from '../services/settings';
import { maskPhone } from '@casino/game-core/mask';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { runWatchdogChecks } from '../services/watchdog';
import { snapshotCounters } from '../services/monitoring';
import { applyBalanceChange } from '../services/wallet';
import { dualControlStage } from '../services/securityPolicy';
import { notifyUser } from '../services/notify';
import {
  hasPreviousKey,
  keyKindFor,
  reencryptToCurrentKey,
} from '../lib/crypto-utils';
import { smtpIsConfigured } from '../services/smtpSettings';

const alertPatchSchema = z.object({
  status: z.enum(['acknowledged', 'resolved']),
});

export async function panelSecurityRoutes(app: FastifyInstance) {
  // ── STEP-UP RE-AUTHENTICATION ────────────────────────────────────────────
  app.post('/auth/reauth', { preHandler: [adminAuthMiddleware] }, async (request) => {
    await rateLimit(request, 'adminReauth', request.admin!.id);
    const body = request.body as { password?: string } | undefined;
    const password = String(body?.password ?? '');
    if (!password)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Enter your password');
    const admin = await prisma.adminUser.findUniqueOrThrow({
      where: { id: request.admin!.id },
      select: { passwordHash: true },
    });
    if (!(await bcrypt.compare(password, admin.passwordHash))) {
      await writeAudit({
        adminId: request.admin!.id,
        action: 'admin.reauth.failed',
        targetType: 'admin',
        targetId: request.admin!.id,
        ip: request.ip,
      });
      throw new AppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401, 'Incorrect password');
    }
    const windowMinutes = await getNumericSetting('admin_step_up_minutes', 15, { min: 1 });
    const stampedAt = Date.now();
    try {
      await redis.set(`admin:stepup:${request.admin!.id}`, String(stampedAt), 'EX', windowMinutes * 60);
    } catch {
      throw new AppError(
        ERROR_CODES.AUTH_STEP_UP_REQUIRED,
        503,
        'Re-authentication could not be recorded — please try again in a moment'
      );
    }
    await writeAudit({
      adminId: request.admin!.id,
      action: 'admin.reauth',
      targetType: 'admin',
      targetId: request.admin!.id,
      afterState: { validForMinutes: windowMinutes },
      ip: request.ip,
    });
    return ok(
      {
        ok: true,
        validForMinutes: windowMinutes,
        expiresAt: new Date(stampedAt + windowMinutes * 60_000).toISOString(),
      },
      request.requestId!
    );
  });

  // ── MONITORING: overview ─────────────────────────────────────────────────
  app.get('/monitoring/overview', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const [report, openAlerts, critical, high, waitingSecond] = await Promise.all([
      runWatchdogChecks(),
      prisma.securityAlert.count({ where: { status: 'open' } }),
      prisma.securityAlert.count({ where: { status: 'open', severity: 'critical' } }),
      prisma.securityAlert.count({ where: { status: 'open', severity: 'high' } }),
      prisma.withdrawal.count({
        where: { dualControlRequired: true, firstApprovedBy: { not: null }, status: 'PENDING' },
      }),
    ]);
    const [frozenAccounts, lockedOutRequests, parkedAdjustments] = await Promise.all([
      prisma.user.count({ where: { withdrawalFrozenUntil: { gt: new Date() } } }),
      prisma.recoveryRequest.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
      prisma.walletAdjustment.count({ where: { status: 'PENDING' } }),
    ]);
    let redisOk = true;
    try {
      await redis.ping();
    } catch {
      redisOk = false;
    }
    let smtpConfigured = false;
    try {
      const { getSettings } = await import('../services/settings');
      smtpConfigured = smtpIsConfigured(await getSettings());
    } catch {
      smtpConfigured = false;
    }

    return ok(
      {
        ranAt: report.ranAt,
        healthy: report.ok,
        checks: report.checks,
        counters: snapshotCounters(),
        alerts: { open: openAlerts, critical, high },
        queues: {
          awaitingSecondApproval: waitingSecond,
          frozenAccounts,
          recoveryRequestsOpen: lockedOutRequests,
          parkedAdjustments,
        },
        redis: redisOk ? 'ok' : 'unreachable',
        emailAlerts: smtpConfigured,
        keyRotationPending: hasPreviousKey(),
      },
      request.requestId!
    );
  });

  // ── MONITORING: alerts ───────────────────────────────────────────────────
  app.get('/monitoring/alerts', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; severity?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const where = {
      ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
      ...(q.severity && q.severity !== 'all' ? { severity: q.severity } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.securityAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 25,
        take: 25,
      }),
      prisma.securityAlert.count({ where }),
    ]);
    return ok({ data: rows, total }, request.requestId!);
  });

  app.patch('/monitoring/alerts/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = alertPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'status must be acknowledged or resolved');
    const existing = await prisma.securityAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Alert not found');
    const updated = await prisma.securityAlert.update({
      where: { id },
      data: {
        status: parsed.data.status,
        acknowledgedBy: request.admin!.id,
        acknowledgedAt: new Date(),
      },
    });
    await writeAudit({
      adminId: request.admin!.id,
      action: `alert.${parsed.data.status}`,
      targetType: 'securityAlert',
      targetId: id,
      beforeState: { status: existing.status },
      afterState: { status: updated.status, kind: existing.kind },
      ip: request.ip,
    });
    return ok({ id, status: updated.status }, request.requestId!);
  });

  app.post('/monitoring/watchdog/run', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const report = await runWatchdogChecks();
    return ok(report, request.requestId!);
  });

  // ── DUAL-CONTROL WALLET ADJUSTMENTS ──────────────────────────────────────
  // Parked credits/debits from Panel → Users → Adjust balance. Listed here so
  // the second admin has one place to clear them, with the requester visible.
  app.get('/wallet-adjustments', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { status?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const where = q.status && q.status !== 'all' ? { status: q.status } : {};
    const [rows, total] = await Promise.all([
      prisma.walletAdjustment.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * 25,
        take: 25,
        include: {
          user: { select: { id: true, phone: true, displayName: true, status: true } },
        },
      }),
      prisma.walletAdjustment.count({ where }),
    ]);
    return ok(
      {
        data: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          userName: row.user?.displayName ?? null,
          userPhone: row.user ? maskPhone(row.user.phone) : null,
          userStatus: row.user?.status ?? null,
          walletType: row.walletType,
          amount: row.amount.toString(),
          reason: row.reason,
          status: row.status,
          requestedBy: row.requestedBy,
          requestedAt: row.requestedAt,
          approvedBy: row.approvedBy,
          approvedAt: row.approvedAt,
          rejectedBy: row.rejectedBy,
          rejectedAt: row.rejectedAt,
          rejectReason: row.rejectReason,
        })),
        total,
      },
      request.requestId!
    );
  });

  app.patch(
    '/wallet-adjustments/:id',
    { preHandler: [adminAuthMiddleware, requireStepUp] },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = z
        .object({
          decision: z.enum(['approve', 'reject']),
          reason: z.string().trim().max(300).optional(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success)
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'decision must be approve or reject');

      const row = await prisma.walletAdjustment.findUnique({ where: { id } });
      if (!row) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Adjustment not found');
      if (row.status !== 'PENDING')
        throw new AppError('FIN_011', 409, `This adjustment was already ${row.status.toLowerCase()}`);

      // Dual control: never the admin who requested it.
      const stage = dualControlStage({
        amount: 1,
        threshold: 1,
        firstApproverId: row.requestedBy,
        approverId: request.admin!.id,
      });
      if (stage.stage === 'rejected')
        throw new AppError(ERROR_CODES.FIN_DUAL_CONTROL_REQUIRED, 403, stage.reason);

      if (parsed.data.decision === 'reject') {
        await writeAudit({
          adminId: request.admin!.id,
          action: 'user.fund.dual_control_rejected',
          targetType: 'walletAdjustment',
          targetId: id,
          beforeState: { status: row.status },
          afterState: { status: 'REJECTED', reason: parsed.data.reason ?? null },
          ip: request.ip,
        });
        await prisma.walletAdjustment.update({
          where: { id },
          data: {
            status: 'REJECTED',
            rejectedBy: request.admin!.id,
            rejectedAt: new Date(),
            rejectReason: parsed.data.reason ?? null,
          },
        });
        return ok({ id, status: 'REJECTED' }, request.requestId!);
      }

      const FIELD: Record<string, 'REAL' | 'BONUS' | 'GIFTED'> = {
        real: 'REAL',
        bonus: 'BONUS',
        gifted: 'GIFTED',
      };
      const walletEnum = FIELD[row.walletType];
      if (!walletEnum)
        throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Unknown wallet type');
      const signed = new Decimal(row.amount.toString());

      await writeAudit({
        adminId: request.admin!.id,
        action: signed.isNegative() ? 'user.debit.dual_control_approved' : 'user.credit.dual_control_approved',
        targetType: 'walletAdjustment',
        targetId: id,
        beforeState: { status: row.status },
        afterState: {
          status: 'APPROVED',
          userId: row.userId,
          walletType: row.walletType,
          amount: signed.toString(),
        },
        ip: request.ip,
      });

      const applied = await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: row.userId } });
        const field =
          walletEnum === 'REAL' ? 'realBalance' : walletEnum === 'BONUS' ? 'bonusBalance' : 'giftedBalance';
        if ((wallet[field] as Decimal).plus(signed).lt(0))
          throw new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            422,
            'Balance cannot go below zero — approve a smaller debit'
          );
        const txn = await applyBalanceChange(
          row.userId,
          walletEnum,
          signed,
          signed.isNegative() ? 'ADMIN_DEBIT' : 'ADMIN_CREDIT',
          {
            referenceType: 'admin',
            referenceId: request.admin!.id,
            description: `Dual-control ${signed.isNegative() ? 'debit' : 'credit'}${row.reason ? `: ${row.reason}` : ''}`,
          },
          tx
        );
        await tx.walletAdjustment.update({
          where: { id },
          data: {
            status: 'APPROVED',
            approvedBy: request.admin!.id,
            approvedAt: new Date(),
            appliedTransactionId: (txn as { id?: string } | undefined)?.id ?? null,
          },
        });
        return txn;
      });
      void applied;

      const label = row.walletType === 'real' ? 'cash' : row.walletType;
      void notifyUser(
        row.userId,
        signed.isNegative() ? 'Balance adjusted' : 'Balance top-up ✅',
        signed.isNegative()
          ? `₨${signed.abs().toNumber().toLocaleString()} was deducted from your ${label} balance${row.reason ? ` (${row.reason})` : ''}.`
          : `₨${signed.toNumber().toLocaleString()} has been added to your ${label} balance${row.reason ? ` (${row.reason})` : ''}.`,
        'wallet',
        '/wallet'
      );
      emitAdmin('wallet-adjustment-approved', {
        id: shortId(id),
        userId: shortId(row.userId),
        amount: signed.toString(),
        at: Date.now(),
      });
      return ok(
        { id, status: 'APPROVED', amount: signed.toString() },
        request.requestId!
      );
    }
  );

  // ── KEY ROTATION ─────────────────────────────────────────────────────────
  // Re-encrypts every value this platform encrypts (player payout accounts and
  // the stored SMTP password) with the CURRENT ENCRYPTION_KEY.
  //
  // Safe by construction: values already on the current key are left exactly as
  // they are, and a value that no configured key can open is reported and
  // SKIPPED rather than being overwritten with something unreadable.
  //
  // Typical use:
  //   1. set ENCRYPTION_KEY=<new> and ENCRYPTION_KEY_PREVIOUS=<old>
  //   2. POST here with { "apply": false }  → see the split
  //   3. POST here with { "apply": true }   → re-encrypt
  //   4. remove ENCRYPTION_KEY_PREVIOUS and restart
  app.post(
    '/maintenance/rotate-encryption-key',
    { preHandler: [adminAuthMiddleware, requireStepUp] },
    async (request) => {
      if (!request.admin!.isSuperAdmin)
        throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 403, 'Super-admin only');
      const body = (request.body ?? {}) as { apply?: boolean };
      const apply = body.apply === true;

      if (!(process.env.ENCRYPTION_KEY || process.env.AES_ENCRYPTION_KEY))
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'ENCRYPTION_KEY is not set — nothing to rotate to'
        );

      const accounts = await prisma.payoutAccount.findMany({
        select: { id: true, accountDetails: true },
      });
      let alreadyCurrent = 0;
      let rotated = 0;
      let unreadable = 0;
      const failures: string[] = [];

      for (const account of accounts) {
        let kind: 'current' | 'previous';
        try {
          kind = keyKindFor(account.accountDetails);
        } catch {
          unreadable += 1;
          failures.push(account.id);
          continue;
        }
        if (kind === 'current') {
          alreadyCurrent += 1;
          continue;
        }
        if (!apply) {
          rotated += 1; // would-be count in dry-run
          continue;
        }
        try {
          const { value } = reencryptToCurrentKey(account.accountDetails);
          await prisma.payoutAccount.update({
            where: { id: account.id },
            data: { accountDetails: value },
          });
          rotated += 1;
        } catch (e) {
          unreadable += 1;
          failures.push(`${account.id}: ${(e as Error).message}`);
        }
      }

      // The SMTP password is encrypted the same way and must be rotated too,
      // otherwise it silently becomes unreadable on the day the old key is
      // dropped from the environment.
      const smtpRow = await prisma.setting.findUnique({ where: { key: 'smtp_password' } });
      let smtpRotated = false;
      if (smtpRow && typeof smtpRow.value === 'string' && smtpRow.value.includes('.')) {
        let kind: 'current' | 'previous' | 'unreadable' = 'unreadable';
        try {
          kind = keyKindFor(smtpRow.value);
        } catch {
          kind = 'unreadable';
        }
        if (kind === 'previous') {
          if (!apply) {
            smtpRotated = true; // dry-run: would rotate
          } else {
            try {
              const { value } = reencryptToCurrentKey(smtpRow.value);
              await prisma.setting.update({
                where: { key: 'smtp_password' },
                data: { value: value as never },
              });
              smtpRotated = true;
            } catch (e) {
              failures.push(`smtp_password: ${(e as Error).message}`);
            }
          }
        }
      }

      const payfastRotation = await rotatePayfastSecrets(apply);
      failures.push(...payfastRotation.failures);

      await writeAudit({
        adminId: request.admin!.id,
        action: apply ? 'maintenance.key_rotation' : 'maintenance.key_rotation.dry_run',
        targetType: 'encryption',
        beforeState: { previousKeyConfigured: hasPreviousKey() },
        afterState: {
          accounts: accounts.length,
          rotated,
          alreadyCurrent,
          unreadable,
          smtpRotated,
        },
        ip: request.ip,
      });
      emitAdmin('key-rotation', { apply, rotated, at: Date.now() });

      return ok(
        {
          apply,
          previousKeyConfigured: hasPreviousKey(),
          payoutAccounts: {
            total: accounts.length,
            rotated,
            alreadyOnCurrentKey: alreadyCurrent,
            unreadable,
          },
          smtpPassword: { rotated: smtpRotated },
          payfast: payfastRotation,
          failures: failures.slice(0, 20),
          next: apply
            ? 'Verify payout accounts and PayFast; do NOT remove ENCRYPTION_KEY_PREVIOUS until all reported failures are resolved and rotation succeeds.'
            : 'Dry run only. Repeat with { "apply": true } to perform the rotation.',
        },
        request.requestId!
      );
    }
  );
}

/** Re-exported so the health/monitoring page can show the configured window. */
export async function stepUpWindowMinutes(): Promise<number> {
  return getNumericSetting('admin_step_up_minutes', 15, { min: 0 });
}

export async function watchdogEnabled(): Promise<boolean> {
  return (await getSetting<boolean>('security_watchdog_enabled')) !== false;
}
