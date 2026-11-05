// apps/api/src/lib/audit.ts — append-only audit, written BEFORE the action (v4 rule)
import { prisma } from '../db/prisma';

export interface AuditInput {
  adminId: string;
  action: string; // "game.config.update", "user.suspend", ...
  targetType?: string;
  targetId?: string;
  beforeState?: unknown;
  afterState?: unknown;
  ip?: string;
}

/** MUST be called before executing the admin action (docs/14, docs/20 rule 25). */
export async function writeAudit(input: AuditInput): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      adminId: input.adminId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      beforeState: input.beforeState as never,
      afterState: input.afterState as never,
      ipAddress: input.ip,
    },
  });
}

// ── H-19: transactional audits ───────────────────────────────────────────────
// Audits used to be written BEFORE the action, outside its transaction — a
// 409 (already reviewed) or a rollback left a "this happened" row for an
// action that never applied, or a mutation committed with no audit when the
// audit write failed. writeAuditTx writes INSIDE the action's transaction so
// the audit and the mutation commit — or roll back — together. The 409 claim
// happens first, so failed/duplicate transitions record nothing.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function writeAuditTx(tx: any, input: AuditInput): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminId: input.adminId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      beforeState: input.beforeState as never,
      afterState: input.afterState as never,
      ipAddress: input.ip,
    },
  });
}
