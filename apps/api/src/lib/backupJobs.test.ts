// apps/api/src/lib/backupJobs.test.ts
//
// The restore is a background job now (see the module header): the HTTP call
// returns immediately and the panel polls. These cases pin what the operator
// depends on — that a failure is REPORTED rather than thrown at a request nobody
// is listening to, that progress moves, that the temp file is cleaned up, and
// that a job cannot be read without its token.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/redis', () => ({
  redis: { set: vi.fn(async () => 'OK'), get: vi.fn(async () => null) },
}));

import { redis } from '../db/redis';
import {
  getRestoreJob,
  resetJobsForTests,
  startRestoreJob,
  type RestoreJob,
} from './backupJobs';
import type { RestoreProgress } from '../services/backupArchive';

let dir: string;
let tempPath: string;

/**
 * Wait for an observable effect rather than a flag: `finishedAt` is stamped
 * before the cleanup and the Redis mirror run, so state alone is not enough.
 */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never became true');
}

/**
 * Poll until the job is fully over — state AND the cleanup/mirror that run in
 * the same `finally` block (finishedAt is stamped there, so it is the signal).
 */
async function settle(jobId: string, token: string): Promise<RestoreJob> {
  for (let i = 0; i < 300; i += 1) {
    const job = await getRestoreJob(jobId, token);
    if (job && job.state !== 'running' && job.finishedAt) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never settled');
}

beforeEach(async () => {
  resetJobsForTests();
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'job-test-'));
  tempPath = join(dir, 'casino-upload-test.tar.gz');
  await writeFile(tempPath, 'pretend archive');
});

describe('startRestoreJob', () => {
  it('returns immediately, then reports a finished restore with its result', async () => {
    const runner = async (
      _path: string,
      onProgress: (p: RestoreProgress) => void
    ): Promise<{ tables: Record<string, number>; objects: { restored: number; failed: number; total: number } }> => {
      onProgress({ stage: 'database' });
      onProgress({ stage: 'images', done: 3, total: 12 });
      onProgress({ stage: 'images', done: 12, total: 12 });
      return { tables: { User: 9 }, objects: { restored: 12, failed: 0, total: 12 } };
    };

    const { jobId, jobToken } = startRestoreJob({
      tempPath,
      startedBy: 'superadmin',
      runner: runner as never,
    });

    // The call already returned while the work continues in the background.
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobToken).toHaveLength(48);

    const job = await settle(jobId, jobToken);
    expect(job.state).toBe('done');
    expect(job.percent).toBe(100);
    expect(job.result).toEqual({ tables: { User: 9 }, objects: { restored: 12, failed: 0, total: 12 } });
    expect(job.startedBy).toBe('superadmin');
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt);
  });

  it('reports a failed restore instead of losing the error', async () => {
    const { jobId, jobToken } = startRestoreJob({
      tempPath,
      startedBy: 'superadmin',
      runner: (async () => {
        throw new Error('could not decide a usable restore key');
      }) as never,
    });

    const job = await settle(jobId, jobToken);
    expect(job.state).toBe('error');
    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/usable restore key/);
    expect(job.percent).toBeLessThan(100);
  });

  it('deletes the uploaded temp file once the job is over (success or failure)', async () => {
    const { jobId, jobToken } = startRestoreJob({
      tempPath,
      startedBy: 'superadmin',
      runner: (async () => ({ tables: {}, objects: { restored: 0, failed: 0, total: 0 } })) as never,
    });
    await settle(jobId, jobToken);
    await until(async () => {
      try {
        await readFile(tempPath);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('mirrors the finished job to Redis so a reload can still read it', async () => {
    const { jobId, jobToken } = startRestoreJob({
      tempPath,
      startedBy: 'superadmin',
      runner: (async () => ({ tables: { User: 1 }, objects: { restored: 0, failed: 0, total: 0 } })) as never,
    });
    await settle(jobId, jobToken);
    await until(() => vi.mocked(redis.set).mock.calls.length > 0);
    const [key, value] = vi.mocked(redis.set).mock.calls[0] as unknown as [string, string];
    expect(key).toBe(`backup:restore:${jobId}`);
    // The mirrored copy carries the token, so it cannot be read without it.
    expect(JSON.parse(value).jobToken).toBe(jobToken);
  });
});

describe('getRestoreJob', () => {
  it('never returns a job for the wrong token', async () => {
    const { jobId } = startRestoreJob({
      tempPath,
      startedBy: 'superadmin',
      runner: (async () => ({ tables: {}, objects: { restored: 0, failed: 0, total: 0 } })) as never,
    });
    expect(await getRestoreJob(jobId, 'not-the-token')).toBeNull();
    expect(await getRestoreJob('00000000-0000-0000-0000-000000000000', 'x')).toBeNull();
  });

  it('reads the mirrored job from Redis when the process no longer has it', async () => {
    const stored: RestoreJob & { jobToken: string } = {
      id: '11111111-1111-1111-1111-111111111111',
      jobToken: 'tok',
      state: 'done',
      stage: 'done',
      label: 'Restore complete.',
      percent: 100,
      startedAt: 1,
      finishedAt: 2,
      startedBy: 'superadmin',
    };
    vi.mocked(redis.get).mockResolvedValueOnce(JSON.stringify(stored));
    const job = await getRestoreJob(stored.id, 'tok');
    expect(job?.state).toBe('done');
    // The token is stripped from what the route returns.
    expect((job as unknown as { jobToken?: string }).jobToken).toBeUndefined();
    // …and a wrong token still fails.
    vi.mocked(redis.get).mockResolvedValueOnce(JSON.stringify(stored));
    expect(await getRestoreJob(stored.id, 'other')).toBeNull();
  });

  it('survives Redis being unreachable after the restore flushed it', async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('redis down'));
    expect(await getRestoreJob('22222222-2222-2222-2222-222222222222', 'tok')).toBeNull();
  });
});
