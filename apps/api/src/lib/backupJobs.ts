// apps/api/src/lib/backupJobs.ts — runs a restore in the BACKGROUND.
//
// The panel used to wait for the whole restore inside a single HTTP request:
// upload the file, wipe every table, rewrite them, re-upload the images, then
// answer. That request can easily run for minutes, and every hop in front of the
// API (Traefik on a Dokploy host, Next's rewrite proxy) is entitled to cut it —
// which is how a restore reported "HTTP 408" after the upload had finished, with
// no way to tell whether the data had been restored or not.
//
// So the restore is now a job:
//   POST /panel/backup/restore/start   → { jobId, jobToken }   (returns at once)
//   GET  /panel/backup/restore/status  → stage, percent, result/error
//
// Two design decisions worth knowing:
//
//  1. State lives in PROCESS MEMORY while the job runs. The restore itself wipes
//     Redis (`restoreJson` flushes the cache after rewriting the tables), so a
//     Redis-backed progress record would be deleted by the very operation it is
//     describing. The terminal state is mirrored to Redis afterwards, which is
//     after the flush, so a page reload or a later visit still finds it.
//
//  2. `status` is authorised by a per-job token, not by the admin session. A
//     restore replaces AdminUser with the rows from the backup, which can
//     invalidate the signed-in admin mid-restore; polling with the session would
//     then fail exactly when the operator most wants to see the outcome.
import { randomUUID, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { redis } from '../db/redis';
import {
  restorePlatformArchive,
  type ArchiveRestoreResult,
  type RestoreProgress,
} from '../services/backupArchive';

export type RestoreJobState = 'running' | 'done' | 'error';

export interface RestoreJob {
  id: string;
  state: RestoreJobState;
  /** Machine stage: verifying | database | images | done | failed. */
  stage: string;
  /** Sentence for the operator, safe to render as-is. */
  label: string;
  percent: number;
  startedAt: number;
  finishedAt?: number;
  startedBy: string;
  result?: ArchiveRestoreResult;
  error?: string;
}

const JOB_TTL_SEC = 24 * 60 * 60;

/** In-process registry: the job is only ever read by this API instance. */
const jobs = new Map<string, { job: RestoreJob; token: string }>();

/** Keeps the map from growing for the life of a long-running process. */
function pruneJobs(now = Date.now()): void {
  for (const [id, entry] of jobs) {
    const finished = entry.job.finishedAt ?? 0;
    if (finished && now - finished > JOB_TTL_SEC * 1000) jobs.delete(id);
  }
}

/** Human wording for each stage — the panel shows this verbatim. */
const STAGE_LABELS: Record<string, string> = {
  verifying: 'Checking the file and its checksums…',
  database: 'Wiping the current data and rewriting it from the backup…',
  images: 'Putting the uploaded images back…',
  done: 'Restore complete.',
  failed: 'Restore failed.',
};

function labelFor(stage: string, progress?: RestoreProgress): string {
  if (stage === 'images' && progress?.total) {
    return `Putting the uploaded images back… ${progress.done ?? 0}/${progress.total}`;
  }
  return STAGE_LABELS[stage] ?? 'Working…';
}

/**
 * Percent reported to the UI. The database step is one transaction with no
 * useful internal milestones, so it is represented as a band rather than a fake
 * fine-grained number: verify 0–10%, database 10–70%, images 70–100%.
 */
function percentFor(stage: string, progress?: RestoreProgress): number {
  if (stage === 'verifying') return 5;
  if (stage === 'database') return 20;
  if (stage === 'images') {
    const total = progress?.total ?? 0;
    const done = progress?.done ?? 0;
    if (!total) return 75;
    return Math.min(99, 70 + Math.round((done / total) * 29));
  }
  return 100;
}

export interface StartRestoreOptions {
  tempPath: string;
  /** Admin id/username, for the audit trail and the status payload. */
  startedBy: string;
  /** Injectable for tests — defaults to the real archive restore. */
  runner?: (path: string, onProgress: (p: RestoreProgress) => void) => Promise<ArchiveRestoreResult>;
  /** Injectable for tests — set to false to keep the temp file. */
  cleanup?: boolean;
}

/** Start a restore job. Returns immediately; the work continues in the background. */
export function startRestoreJob(opts: StartRestoreOptions): { jobId: string; jobToken: string } {
  pruneJobs();
  const id = randomUUID();
  const token = randomBytes(24).toString('hex');
  const job: RestoreJob = {
    id,
    state: 'running',
    stage: 'verifying',
    label: STAGE_LABELS.verifying ?? 'Checking the file…',
    percent: percentFor('verifying'),
    startedAt: Date.now(),
    startedBy: opts.startedBy,
  };
  jobs.set(id, { job, token });

  const runner = opts.runner ?? ((path, onProgress) => restorePlatformArchive(path, onProgress));
  const setProgress = (p: RestoreProgress): void => {
    job.stage = p.stage;
    job.label = labelFor(p.stage, p);
    job.percent = percentFor(p.stage, p);
  };

  // Deliberately not awaited: the HTTP response goes out now, and the panel
  // polls. Any failure is captured on the job instead of being thrown at a
  // request that may no longer be listening.
  void (async () => {
    try {
      const result = await runner(opts.tempPath, setProgress);
      job.state = 'done';
      job.stage = 'done';
      job.label = STAGE_LABELS.done ?? 'Restore complete.';
      job.percent = 100;
      job.result = result;
    } catch (e) {
      job.state = 'error';
      job.stage = 'failed';
      job.label = STAGE_LABELS.failed ?? 'Restore failed.';
      const message = e instanceof Error ? e.message : 'Restore failed';
      job.error = message; // already user-facing for AppError 4xx from the service
    } finally {
      job.finishedAt = Date.now();
      if (opts.cleanup !== false) await rm(opts.tempPath, { force: true }).catch(() => undefined);
      // Mirror the outcome for a later page load. Safe now: the restore's own
      // flushdb has already happened.
      await redis
        .set(`backup:restore:${id}`, JSON.stringify({ ...job, jobToken: token }), 'EX', JOB_TTL_SEC)
        .catch(() => undefined);
    }
  })();

  return { jobId: id, jobToken: token };
}

/** The live job, or the mirrored copy from Redis after a reload/restart. */
export async function getRestoreJob(
  jobId: string,
  jobToken: string
): Promise<RestoreJob | null> {
  const local = jobs.get(jobId);
  if (local) {
    // Constant-time-ish equality is unnecessary here (the token is a random
    // 48-hex-char secret and the endpoint is rate-limited), but never leak
    // whether the id exists without the token.
    if (local.token !== jobToken) return null;
    return local.job;
  }
  try {
    const raw = await redis.get(`backup:restore:${jobId}`);
    if (!raw) return null;
    const stored = JSON.parse(raw) as RestoreJob & { jobToken?: string };
    // A mirrored job is only readable with the token it was created with.
    if (stored.jobToken !== jobToken) return null;
    const { jobToken: _drop, ...job } = stored;
    return job;
  } catch {
    return null;
  }
}

/** Test seam: forget every job (never used by production routes). */
export function resetJobsForTests(): void {
  jobs.clear();
}
