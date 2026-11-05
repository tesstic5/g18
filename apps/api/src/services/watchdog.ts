// apps/api/src/services/watchdog.ts — the "someone is told" job.
//
// The security inventory found no monitoring or alerting of any kind: a backup
// could stop running for a month, Redis could die (silently turning the rate
// limiter into a no-op), a payout could sit unapproved, and nobody would know
// until a human happened to look. This job is what looks.
//
// It runs from the worker (which has both the database and the backup volume
// mounted) on an hourly cron, and can also be triggered on demand from
// Panel → Monitoring so an operator can answer "is anything wrong right now?"
// without waiting for the next tick.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db/prisma';
import { redis } from '../db/redis';
import { alert, raiseAlert } from './monitoring';
import { ageInDays } from './securityPolicy';
import { getNumericSetting, getSetting } from './settings';

export interface WatchdogCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** True when this run raised a NEW alert (deduped runs report false). */
  alerted: boolean;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface WatchdogReport {
  ranAt: string;
  durationMs: number;
  ok: boolean;
  checks: WatchdogCheck[];
}

/** Where to look for backup files. The worker mounts the backup volume here. */
function backupDirs(): string[] {
  const dirs = [process.env.BACKUP_DIR || '/app/backups'];
  for (const extra of String(process.env.BACKUP_EXTRA_DIRS ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) dirs.push(trimmed);
  }
  return dirs;
}

const BACKUP_FILE = /^backup-.*\.(json|cbk)$/;
/** Also accept the script-produced one-file platform backups. */
const PLATFORM_FILE = /\.(cpb|cbk)$/;

export interface BackupScan {
  latestAt: Date | null;
  latestFile: string | null;
  found: number;
}

/**
 * Newest backup file across every configured directory. Unreadable directories
 * are skipped rather than failing the check — on a deployment where the api
 * container has no backup mount, "cannot see" must not read as "no backup".
 */
export async function scanBackups(dirs: string[] = backupDirs()): Promise<BackupScan> {
  let latestAt: Date | null = null;
  let latestFile: string | null = null;
  let found = 0;
  let readableDirs = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
      readableDirs += 1;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!BACKUP_FILE.test(entry) && !PLATFORM_FILE.test(entry)) continue;
      try {
        const info = await stat(path.join(dir, entry));
        if (!info.isFile()) continue;
        found += 1;
        if (!latestAt || info.mtime > latestAt) {
          latestAt = info.mtime;
          latestFile = path.join(dir, entry);
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  if (readableDirs === 0) return { latestAt: null, latestFile: null, found: -1 };
  return { latestAt, latestFile, found };
}

async function checkHealth(): Promise<WatchdogCheck> {
  const services: Record<string, string> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    services['database'] = 'ok';
  } catch {
    services['database'] = 'error';
  }
  try {
    await redis.ping();
    services['redis'] = 'ok';
  } catch (e) {
    services['redis'] = 'error';
    void alert.redisDown((e as Error).message);
  }
  const ok = Object.values(services).every((v) => v === 'ok');
  let alerted = false;
  if (!ok) alerted = await alert.healthDegraded(services);
  return {
    name: 'services',
    ok,
    detail: Object.entries(services)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
    alerted,
    severity: ok ? undefined : 'high',
  };
}

async function checkBackups(): Promise<WatchdogCheck> {
  const maxAgeHours = await getNumericSetting('backup_max_age_hours', 30, { min: 1 });
  const scan = await scanBackups();
  if (scan.found === -1) {
    // No backup directory is visible from this process. Report honestly rather
    // than alerting on a mount that simply is not there.
    return {
      name: 'backup_freshness',
      ok: true,
      detail: 'no backup directory visible from this process — check skipped',
      alerted: false,
    };
  }
  const ageHours = scan.latestAt
    ? (Date.now() - scan.latestAt.getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;
  if (scan.latestAt && ageHours <= maxAgeHours) {
    return {
      name: 'backup_freshness',
      ok: true,
      detail: `newest backup ${path.basename(scan.latestFile ?? '')} is ${ageHours.toFixed(1)}h old (${scan.found} file(s) on disk)`,
      alerted: false,
    };
  }
  const alerted = await alert.backupStale(
    Number.isFinite(ageHours) ? Math.floor(ageHours / 24) : -1,
    scan.latestAt ? scan.latestAt.toISOString() : null
  );
  return {
    name: 'backup_freshness',
    ok: false,
    detail: scan.latestAt
      ? `newest backup is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`
      : 'no backup file found in any configured directory',
    alerted,
    severity: 'critical',
  };
}

async function checkDualControlQueue(): Promise<WatchdogCheck> {
  const waitMinutes = await getNumericSetting('dual_control_wait_alert_minutes', 60, { min: 5 });
  const cutoff = new Date(Date.now() - waitMinutes * 60_000);
  const waiting = await prisma.withdrawal.findMany({
    where: { dualControlRequired: true, firstApprovedBy: { not: null }, status: 'PENDING' },
    select: { id: true, amount: true, firstApprovedAt: true },
    take: 50,
  });
  const stalled = waiting.filter(
    (w) => w.firstApprovedAt && w.firstApprovedAt.getTime() <= cutoff.getTime()
  );
  let alerted = false;
  for (const w of stalled) {
    const mins = Math.round((Date.now() - (w.firstApprovedAt as Date).getTime()) / 60_000);
    const raised = await alert.dualControlPending(
      'withdrawal',
      w.id,
      w.amount.toString(),
      mins
    );
    alerted = alerted || raised;
  }
  return {
    name: 'dual_control_queue',
    ok: stalled.length === 0,
    detail:
      stalled.length === 0
        ? `${waiting.length} awaiting a second approval, none older than ${waitMinutes}m`
        : `${stalled.length} withdrawal(s) waiting > ${waitMinutes}m for a second approval`,
    alerted,
    severity: stalled.length === 0 ? undefined : 'medium',
  };
}

async function checkFraudSpike(): Promise<WatchdogCheck> {
  const threshold = await getNumericSetting('fraud_spike_threshold', 10, { min: 1 });
  const windowMinutes = await getNumericSetting('fraud_spike_window_minutes', 60, { min: 5 });
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const count = await prisma.fraudSignal.count({
    where: { createdAt: { gte: since }, severity: { in: ['high', 'medium'] } },
  });
  const ok = count < threshold;
  const alerted = ok ? false : await alert.fraudSpike(count, windowMinutes);
  return {
    name: 'fraud_spike',
    ok,
    detail: `${count} medium/high fraud signal(s) in the last ${windowMinutes}m (threshold ${threshold})`,
    alerted,
    severity: ok ? undefined : 'high',
  };
}

async function checkRecoveryQueue(): Promise<WatchdogCheck> {
  const hours = await getNumericSetting('recovery_wait_alert_hours', 24, { min: 1 });
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const stalled = await prisma.recoveryRequest.count({
    where: { status: { in: ['PENDING', 'IN_REVIEW'] }, createdAt: { lt: cutoff } },
  });
  const ok = stalled === 0;
  const alerted = ok
    ? false
    : await raiseAlert({
        kind: 'recovery.awaiting_agent',
        severity: 'medium',
        message: `${stalled} account-recovery request(s) have been waiting more than ${hours}h — locked-out players cannot self-serve`,
        data: { stalled, hours },
        dedupeKey: 'recovery.awaiting_agent',
        dedupeMinutes: 720,
        email: true,
      });
  return {
    name: 'recovery_queue',
    ok,
    detail: ok ? 'no request older than the limit' : `${stalled} request(s) waiting > ${hours}h`,
    alerted,
    severity: ok ? undefined : 'medium',
  };
}

async function checkPendingWithdrawals(): Promise<WatchdogCheck> {
  const hours = await getNumericSetting('withdrawal_age_alert_hours', 24, { min: 1 });
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const count = await prisma.withdrawal.count({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
  });
  const ok = count === 0;
  const alerted = ok
    ? false
    : await raiseAlert({
        kind: 'withdrawal.awaiting_review',
        severity: 'medium',
        message: `${count} withdrawal(s) have been pending more than ${hours}h`,
        data: { count, hours },
        dedupeKey: 'withdrawal.awaiting_review',
        dedupeMinutes: 720,
        email: true,
      });
  return {
    name: 'withdrawal_queue',
    ok,
    detail: ok ? 'nothing stalled' : `${count} withdrawal(s) pending > ${hours}h`,
    alerted,
    severity: ok ? undefined : 'medium',
  };
}

async function checkKeyRotation(): Promise<WatchdogCheck> {
  const { hasPreviousKey } = await import('../lib/crypto-utils');
  const pending = hasPreviousKey();
  // Not an alert: this is the EXPECTED state mid-rotation. It is surfaced so an
  // operator who forgot to finish a rotation sees it every single run.
  return {
    name: 'key_rotation',
    ok: !pending,
    detail: pending
      ? 'ENCRYPTION_KEY_PREVIOUS is still set — run the rotation job, then remove it'
      : 'single encryption key in use',
    alerted: false,
    severity: pending ? 'medium' : undefined,
  };
}

/**
 * Run every check. Individual failures are captured per-check so one broken
 * query cannot hide the rest of the report.
 */
export async function runWatchdogChecks(): Promise<WatchdogReport> {
  const started = Date.now();
  const enabled = await getSetting<boolean>('security_watchdog_enabled');
  if (enabled === false) {
    return {
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: true,
      checks: [
        {
          name: 'watchdog',
          ok: true,
          detail: 'disabled in settings (security_watchdog_enabled = false)',
          alerted: false,
        },
      ],
    };
  }

  const runners: Array<[string, () => Promise<WatchdogCheck>]> = [
    ['services', checkHealth],
    ['backup_freshness', checkBackups],
    ['dual_control_queue', checkDualControlQueue],
    ['fraud_spike', checkFraudSpike],
    ['recovery_queue', checkRecoveryQueue],
    ['withdrawal_queue', checkPendingWithdrawals],
    ['key_rotation', checkKeyRotation],
  ];

  const checks: WatchdogCheck[] = [];
  for (const [, run] of runners) {
    try {
      checks.push(await run());
    } catch (e) {
      checks.push({
        name: 'unknown',
        ok: false,
        detail: `check failed: ${(e as Error).message}`,
        alerted: false,
        severity: 'medium',
      });
    }
  }
  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/** Data-retention purge (worker cron). Returns a per-table row count. */
export async function runRetentionPurge(): Promise<Record<string, number>> {
  const { retentionCutoff } = await import('./securityPolicy');
  const loginEvents = retentionCutoff(await getNumericSetting('retention_login_events_days', 180, { min: 0 }));
  const notifications = retentionCutoff(
    await getNumericSetting('retention_notifications_days', 90, { min: 0 })
  );
  const recovery = retentionCutoff(
    await getNumericSetting('retention_recovery_requests_days', 365, { min: 0 })
  );

  const out: Record<string, number> = {};
  if (loginEvents.before) {
    // Device history is what proves an account's real owner — keep it longer
    // than the raw login events it is derived from.
    out.loginEvents = (
      await prisma.userLoginEvent.deleteMany({ where: { createdAt: { lt: loginEvents.before } } })
    ).count;
  }
  if (notifications.before) {
    out.notifications = (
      await prisma.notification.deleteMany({
        where: { createdAt: { lt: notifications.before }, isRead: true },
      })
    ).count;
  }
  if (recovery.before) {
    // Closed cases only: an open request is live evidence, not history.
    out.recoveryRequests = (
      await prisma.recoveryRequest.deleteMany({
        where: {
          createdAt: { lt: recovery.before },
          status: { in: ['REDEEMED', 'REJECTED', 'EXPIRED'] },
        },
      })
    ).count;
  }

  // Password history is capped by depth, not age — trim anything past the cap.
  const depth = await getNumericSetting('password_history_depth', 3, { min: 0 });
  if (depth > 0) {
    const users = await prisma.passwordHistory.groupBy({
      by: ['userId'],
      _count: { userId: true },
      having: { userId: { _count: { gt: depth } } },
    });
    let trimmed = 0;
    for (const row of users) {
      const stale = await prisma.passwordHistory.findMany({
        where: { userId: row.userId },
        orderBy: { createdAt: 'desc' },
        skip: depth,
        select: { id: true },
      });
      if (stale.length) {
        trimmed += (
          await prisma.passwordHistory.deleteMany({
            where: { id: { in: stale.map((s) => s.id) } },
          })
        ).count;
      }
    }
    out.passwordHistory = trimmed;
  }
  return out;
}

/** Oldest login event age, for the monitoring page. */
export async function oldestLoginEventDays(): Promise<number | null> {
  const oldest = await prisma.userLoginEvent.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!oldest) return null;
  const age = ageInDays(oldest.createdAt);
  return Number.isFinite(age) ? age : null;
}
