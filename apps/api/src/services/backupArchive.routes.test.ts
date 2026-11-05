// apps/api/src/services/backupArchive.routes.test.ts
//
// Route-level proof: a real Fastify server using the real upload parser, the
// real archive service and the real tar reader — the wiring in server.ts and
// routes/panel.ts, without standing up Postgres, MinIO and Redis.
//
// Unit tests cannot cover the parts that broke in practice:
//   * that the download route STREAMS a usable archive in the HTTP response,
//   * that the body of that very response can be fed back into the upload route,
//   * that the size ceiling leaves no partial file behind,
//   * that a junk file produces a 422 the panel can show, not a masked 500.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const store = new Map<string, Buffer>();
const fakeListObjects = (bucket: string) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const [k, v] of store)
      if (k.startsWith(`${bucket}/`)) yield { name: k.slice(bucket.length + 1), size: v.length };
  },
});
vi.mock('../db/minio', () => ({
  MinioClient: {
    listObjectsV2: (bucket: string) => fakeListObjects(bucket),
    getObject: async (bucket: string, key: string) =>
      Readable.from([store.get(`${bucket}/${key}`)!]),
    fPutObject: async (bucket: string, key: string, path: string) =>
      void store.set(`${bucket}/${key}`, readFileSync(path)),
  },
  ensureBuckets: async () => undefined,
}));
const BUNDLE = { version: 2, tables: { User: [{ id: 'u1' }] } };
vi.mock('../db/prisma', () => ({ prisma: { $queryRawUnsafe: async () => [{ c: 7 }] } }));
vi.mock('./backup', () => ({
  exportJson: async () => BUNDLE,
  restoreJson: async () => ({ User: 1 }),
}));
vi.mock('../lib/crypto-utils', () => ({ currentKeyFingerprint: () => 'feedfacefeedface' }));

const Fastify = (await import('fastify')).default;
const { buildPlatformArchive, restorePlatformArchive } = await import('./backupArchive');
const { createArchiveUploadParser } = await import('../lib/archiveUploadParser');

const uploadDir = await mkdtemp(join(tmpdir(), 'route-upload-'));
const app = Fastify({ bodyLimit: 10 * 1024 * 1024, requestTimeout: 30_000 });
// Exactly as registered in server.ts
app.addContentTypeParser(['application/gzip', 'application/x-gzip'], createArchiveUploadParser({ dir: uploadDir }));

// Exactly as registered in routes/panel.ts (minus auth/audit)
app.get('/backup/download', async (_req, reply) => {
  const { stream, manifest } = await buildPlatformArchive();
  reply.header('Content-Type', 'application/gzip');
  reply.header('Content-Disposition', 'attachment; filename="casino-platform-x.tar.gz"');
  reply.header('X-Backup-Objects', String(manifest.objects.count));
  reply.header('Cache-Control', 'no-store');
  return reply.send(stream);
});
app.post('/backup/restore-archive', { onRequest: [async () => {}], bodyLimit: 5 * 1024 * 1024 }, async (request) => {
  const body = request.body as { tempPath: string; bytes: number };
  try {
    const result = await restorePlatformArchive(body.tempPath);
    return result;
  } finally {
    await rm(body.tempPath, { force: true });
  }
});

beforeEach(() => {
  store.clear();
  store.set('deposit-proofs/proof.jpg', Buffer.from('image-bytes'));
  store.set('user-avatars/a.png', Buffer.from('avatar'));
});

afterAll(async () => {
  await app.close();
  await rm(uploadDir, { recursive: true, force: true });
});

describe('one-file backup routes', () => {
  it('streams a downloadable archive that system tar can read', async () => {
    const res = await app.inject({ method: 'GET', url: '/backup/download' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(String(res.headers['content-disposition'])).toContain('casino-platform-');
    expect(res.headers['x-backup-objects']).toBe('2');

    const dir = await mkdtemp(join(tmpdir(), 'route-dl-'));
    const file = join(dir, 'dl.tar.gz');
    await pipeline(Readable.from([res.rawPayload]), createWriteStream(file));
    const listing = execFileSync('tar', ['-tzf', file]).toString().trim().split('\n');
    expect(listing).toContain('manifest.json');
    expect(listing).toContain('database.json');
    expect(listing).toContain('RESTORE.txt');
    expect(listing).toContain('objects/deposit-proofs/proof.jpg');
    const db = JSON.parse(execFileSync('tar', ['-xzOf', file, 'database.json']).toString());
    expect(db).toEqual(BUNDLE);
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts that same downloaded file back and restores it', async () => {
    const dl = await app.inject({ method: 'GET', url: '/backup/download' });
    store.clear(); // prove the restore is what puts everything back

    const res = await app.inject({
      method: 'POST',
      url: '/backup/restore-archive',
      headers: { 'content-type': 'application/gzip' },
      payload: dl.rawPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      tables: { User: 1 },
      objects: { restored: 2, failed: 0, total: 2 },
    });
    expect(store.get('deposit-proofs/proof.jpg')?.toString()).toBe('image-bytes');
  });

  it('refuses an over-limit upload and leaves no file behind', async () => {
    const before = (await readdir(uploadDir)).length;
    const res = await app.inject({
      method: 'POST',
      url: '/backup/restore-archive',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.alloc(6 * 1024 * 1024, 3),
    });
    expect(res.statusCode).toBe(413);
    expect((await readdir(uploadDir)).length).toBe(before);
  });

  it('answers 422 (not a masked 500) for a file that is not a backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-junk-'));
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'hello.txt'), 'hello'));
    const file = join(dir, 'junk.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', dir, 'hello.txt']);
    const res = await app.inject({
      method: 'POST',
      url: '/backup/restore-archive',
      headers: { 'content-type': 'application/gzip' },
      payload: readFileSync(file),
    });
    // statusCode comes from the service's AppError — the API's error handler
    // forwards the message of any 4xx, which is why this is not a 500.
    expect(res.statusCode).toBe(422);
    expect(res.payload).toContain('not a platform backup');
    await rm(dir, { recursive: true, force: true });
  });
});
