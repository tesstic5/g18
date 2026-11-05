// apps/api/src/services/monitoring.ts — ALERTS + METRICS.
//
// The security inventory's finding was blunt: nothing told anyone when things
// went wrong. A silently failing backup, a Redis outage that quietly turned the
// limiter off, a fraud spike, a payout pushed through a freeze — all of it was
// invisible until a human happened to look.
//
// This module is the "someone is told" path:
//   • raiseAlert() persists a SecurityAlert row (so "was anyone told?" is
//     answerable after the fact), pushes it to the admin feed, and POSTs it to
//     ALERTS_WEBHOOK_URL when one is configured. An optional email leg rides on
//     the SMTP settings the backup job already uses.
//   • Counters + a Prometheus text renderer for /metrics.
//
// Everything here is FAIL-SOFT by design: monitoring must never be the reason a
// request fails. Every entry point catches its own errors.

import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { emitAdmin, shortId } from '../lib/admin-feed';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  message: string;
  data?: Record<string, unknown>;
  /** Same key inside the dedupe window → folded into the existing alert. */
  dedupeKey?: string;
  /** Suppress repeats for this long (default 30 min). */
  dedupeMinutes?: number;
  /** Also email the backup recipients. Off by default (noisy paths opt out). */
  email?: boolean;
}

const DEDUPE_DEFAULT_MINUTES = 30;

/** Severity ordering, used by the panel and the watchdog. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Per-minute counters for /metrics. Deliberately in-process and bounded: a
 * metric store is Prometheus's job, this is just enough to alert on.
 */
interface Counters {
  requests: number;
  errors5xx: number;
  /**
   * 4xx responses whose CODE is not one this platform ever issues. A handful is
   * a scan; a run of them is someone probing for endpoints/handlers that do not
   * exist. Counted separately from errors5xx so a 5xx alert is not diluted by
   * ordinary bad input.
   */
  unexpected4xx: number;
  loginFailures: number;
  logins: number;
  withdrawalsCreated: number;
  withdrawalsHeld: number;
  alertsRaised: number;
  rateLimited: number;
  limiterFallbacks: number;
}

const counters: Counters = {
  requests: 0,
  errors5xx: 0,
  unexpected4xx: 0,
  loginFailures: 0,
  logins: 0,
  withdrawalsCreated: 0,
  withdrawalsHeld: 0,
  alertsRaised: 0,
  rateLimited: 0,
  limiterFallbacks: 0,
};

const startedAt = Date.now();

/** Monotonic (never reset) totals, so a scrape cannot miss a spike entirely. */
export function bumpCounter(name: keyof Counters, by = 1): void {
  counters[name] += by;
}

export function snapshotCounters(): Readonly<Counters> {
  return { ...counters };
}

/** Diagnostic codes that are normal traffic, not incidents. */
const EXPECTED_CODES = new Set([
  'AUTH_001', // wrong password
  'AUTH_003', // expired token
  'AUTH_009', // account locked
  'GEN_001', // validation
  'GEN_002', // not found
  'GEN_003', // rate limited
  'GEN_004',
  'CSRF_INVALID',
]);

/**
 * Called from the error handler (which is the only place the machine-readable
 * code is available). Counts server errors and alerts on a burst; counts
 * unexpected client errors so probing is visible on /metrics.
 */
export function recordError(statusCode: number, code: string): void {
  if (statusCode >= 500) {
    counters.errors5xx += 1;
    void maybeAlertOnSustainedErrors(`http.${statusCode}`, code);
    return;
  }
  // EXPECTED_CODES above lists the diagnostics normal traffic produces (wrong
  // password, expired token, validation, rate limit). Anything else in the 4xx
  // range means a caller reached a state this platform was not written to
  // produce — worth seeing, not worth paging on.
  if (statusCode >= 400 && !EXPECTED_CODES.has(code)) counters.unexpected4xx += 1;
}

let lastBurstAlertAt = 0;
let lastBurstCount = 0;

/**
 * A single 5xx is noise; a run of them is an incident. Raised once per
 * `dedupeMinutes` by raisingAlert()'s own dedupe, so no extra state is needed.
 */
async function maybeAlertOnSustainedErrors(kind: string, code: string): Promise<void> {
  const total = counters.errors5xx;
  const now = Date.now();
  if (total < 10) return;
  if (now - lastBurstAlertAt < 5 * 60_000 && total - lastBurstCount < 10) return;
  lastBurstAlertAt = now;
  lastBurstCount = total;
  await raiseAlert({
    kind: 'http.error_burst',
    severity: 'high',
    message: `Server error burst: ${total} 5xx responses this process lifetime (latest: ${kind}/${code})`,
    data: { statusErrors: total, lastCode: code },
    dedupeKey: 'http.error_burst',
    dedupeMinutes: 15,
    email: true,
  });
}

/** Prometheus text exposition (version 0.0.4). No dependency needed. */
export function renderMetrics(extra: Record<string, number> = {}): string {
  const lines: string[] = [];
  const counter = (name: string, value: number, help: string) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };
  counter('casino_uptime_seconds', Math.floor((Date.now() - startedAt) / 1000), 'Process uptime');
  counter(
    'casino_unexpected_client_errors_total',
    counters.unexpected4xx,
    '4xx responses carrying a diagnostic code the platform never issues'
  );
  counter('casino_requests_total', counters.requests, 'HTTP requests handled');
  counter('casino_errors_5xx_total', counters.errors5xx, 'HTTP 5xx responses');
  counter('casino_logins_total', counters.logins, 'Successful player logins');
  counter('casino_login_failures_total', counters.loginFailures, 'Failed player logins');
  counter(
    'casino_withdrawals_created_total',
    counters.withdrawalsCreated,
    'Withdrawal requests created'
  );
  counter('casino_withdrawals_held_total', counters.withdrawalsHeld, 'Withdrawals held by a freeze');
  counter('casino_rate_limited_total', counters.rateLimited, 'Requests rejected by the limiter');
  counter(
    'casino_limiter_fallbacks_total',
    counters.limiterFallbacks,
    'Times the limiter fell back to in-process counting'
  );
  lines.push('# HELP casino_alerts_raised_total Security alerts raised');
  lines.push('# TYPE casino_alerts_raised_total counter');
  lines.push(`casino_alerts_raised_total ${counters.alertsRaised}`);
  for (const [name, value] of Object.entries(extra)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Constant-time comparison for the metrics bearer token. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function postWebhook(alert: AlertInput): Promise<void> {
  const url = process.env.ALERTS_WEBHOOK_URL || '';
  if (!url.startsWith('http')) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: alert.kind,
        severity: alert.severity,
        message: alert.message,
        data: alert.data ?? {},
        at: new Date().toISOString(),
        platform: process.env.NEXT_PUBLIC_PLATFORM_NAME || 'casino',
      }),
      signal: controller.signal,
    });
  } catch (e) {
    console.error('[monitoring] webhook failed:', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raise an alert. Never throws: every failure path logs and returns false.
 * Returns true when a NEW alert row was written (false when deduped).
 */
export async function raiseAlert(input: AlertInput): Promise<boolean> {
  try {
    const dedupeMinutes = input.dedupeMinutes ?? DEDUPE_DEFAULT_MINUTES;
    if (input.dedupeKey) {
      const since = new Date(Date.now() - dedupeMinutes * 60_000);
      const existing = await prisma.securityAlert.findFirst({
        where: { dedupeKey: input.dedupeKey, createdAt: { gte: since } },
        select: { id: true },
      });
      if (existing) return false;
    }
    await prisma.securityAlert.create({
      data: {
        kind: input.kind,
        severity: input.severity,
        message: input.message.slice(0, 500),
        data: (input.data ?? undefined) as never,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
    counters.alertsRaised += 1;
    emitAdmin('security-alert', {
      kind: input.kind,
      severity: input.severity,
      message: input.message.slice(0, 160),
      at: Date.now(),
    });
    void postWebhook(input);
    if (input.email) void emailAlert(input);
    return true;
  } catch (e) {
    console.error('[monitoring] raiseAlert failed:', (e as Error).message);
    return false;
  }
}

/**
 * Email leg. Imports lazily and swallows everything: alerting must not depend
 * on SMTP being configured (the mail settings live in the DB and may not exist
 * at all on a fresh install).
 */
async function emailAlert(input: AlertInput): Promise<void> {
  try {
    const { sendAlertEmail } = await import('./alertsMail');
    await sendAlertEmail(input);
  } catch (e) {
    console.error('[monitoring] alert email skipped:', (e as Error).message);
  }
}

/** Convenience wrappers used across the codebase. */
export const alert = {
  backupStale: (ageDays: number, lastSuccessAt: string | null) =>
    raiseAlert({
      kind: 'backup.stale',
      severity: 'critical',
      message:
        `No successful database backup in ${ageDays} day(s)` +
        (lastSuccessAt ? ` (last: ${lastSuccessAt})` : ' (none on record)'),
      data: { ageDays, lastSuccessAt },
      dedupeKey: 'backup.stale',
      dedupeMinutes: 720,
      email: true,
    }),
  healthDegraded: (services: Record<string, string>) =>
    raiseAlert({
      kind: 'health.degraded',
      severity: 'high',
      message: `Service health degraded: ${Object.entries(services)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
      data: services,
      dedupeKey: 'health.degraded',
      dedupeMinutes: 30,
      email: true,
    }),
  limiterStoreDown: (detail: string) =>
    raiseAlert({
      kind: 'rate_limit.store_down',
      severity: 'high',
      message:
        'The rate-limit store is unreachable — the limiter is running on its in-process fallback',
      data: { detail },
      dedupeKey: 'rate_limit.store_down',
      dedupeMinutes: 60,
      email: true,
    }),
  fraudSpike: (count: number, windowMinutes: number) =>
    raiseAlert({
      kind: 'fraud.spike',
      severity: 'high',
      message: `${count} high-severity fraud signals in the last ${windowMinutes} minutes`,
      data: { count, windowMinutes },
      dedupeKey: 'fraud.spike',
      dedupeMinutes: 60,
      email: true,
    }),
  freezeOverride: (withdrawalId: string, adminId: string, userId: string) =>
    raiseAlert({
      kind: 'money.freeze_override',
      severity: 'high',
      message: `A payout was pushed through an active recovery freeze (withdrawal ${shortId(withdrawalId)})`,
      data: { withdrawalId, adminId, userId },
      dedupeKey: `money.freeze_override:${withdrawalId}`,
      dedupeMinutes: 1440,
      email: true,
    }),
  dualControlPending: (kind: string, id: string, amount: string, waitingMinutes: number) =>
    raiseAlert({
      kind: `${kind}.awaiting_second_approval`,
      severity: 'medium',
      message: `${kind} ${shortId(id)} (${amount}) has been waiting ${waitingMinutes} min for a second approval`,
      data: { id, amount, waitingMinutes },
      dedupeKey: `${kind}.awaiting:${id}`,
      dedupeMinutes: 240,
    }),
  redisDown: (detail: string) =>
    raiseAlert({
      kind: 'redis.down',
      severity: 'high',
      message: 'Redis is unreachable — sessions, limits and realtime features degrade',
      data: { detail },
      dedupeKey: 'redis.down',
      dedupeMinutes: 30,
      email: true,
    }),
};
