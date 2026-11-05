// apps/api/src/services/backupArchive.test.ts
//
// Exercises the ONE-FILE backup end to end with MinIO and Postgres faked:
// build → stream to disk → verify → extract → restore. The parts that matter
// are the ones a human cannot check by looking at the page:
//   * a long S3 object key survives the tar round trip,
//   * the manifest checksum actually catches a tampered database.json,
//   * an archive crafted with ../ paths cannot write outside the temp folder,
//   * restoring puts every image back byte-for-byte,
//   * the archive this code writes is readable by SUN/system tar.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

// ── fakes ──────────────────────────────────────────────────────────────────
const store = new Map<string, Buffer>();
const restoreCalls: string[] = [];

const fakeListObjects = (bucket: string) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const [k, v] of store) {
      if (k.startsWith(`${bucket}/`)) yield { name: k.slice(bucket.length + 1), size: v.length };
    }
  },
});

vi.mock('../db/minio', () => ({
  MinioClient: {
    listObjectsV2: (bucket: string) => fakeListObjects(bucket),
    getObject: async (bucket: string, key: string) => {
      const data = store.get(`${bucket}/${key}`);
      if (!data) throw new Error(`object missing: ${bucket}/${key}`);
      return Readable.from([data]);
    },
    fPutObject: async (bucket: string, key: string, path: string) => {
      restoreCalls.push(`${bucket}/${key}`);
      store.set(`${bucket}/${key}`, await readFile(path));
    },
  },
  ensureBuckets: async () => undefined,
}));

vi.mock('../db/prisma', () => ({
  prisma: { $queryRawUnsafe: async () => [{ c: 42 }] },
}));

const BUNDLE = { version: 2, tables: { User: [{ id: 'u1' }], Wallet: [] } };
vi.mock('./backup', () => ({
  exportJson: async () => BUNDLE,
  restoreJson: async () => ({ User: 1, Wallet: 0 }),
}));

vi.mock('../lib/crypto-utils', () => ({
  currentKeyFingerprint: () => 'deadbeefdeadbeef',
}));

const {
  buildPlatformArchive,
  extractArchive,
  restorePlatformArchive,
  parseObjectEntry,
  objectEntryName,
  describePlatformBackup,
  writeStreamToTempFile,
} = await import('./backupArchive');

// ── helpers ────────────────────────────────────────────────────────────────
const made: string[] = [];

async function newWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archive-test-'));
  made.push(dir);
  return dir;
}

async function writeArchive(): Promise<string> {
  const { stream } = await buildPlatformArchive();
  const file = join(await newWorkDir(), 'backup.tar.gz');
  await pipeline(stream, createWriteStream(file));
  return file;
}

function seedStore(): void {
  store.clear();
  restoreCalls.length = 0;
  store.set('deposit-proofs/shot.png', Buffer.from([1, 2, 3, 4, 5]));
  store.set('user-avatars/me.jpg', Buffer.from('avatar-bytes'));
  store.set('deposit-proofs/empty.bin', Buffer.alloc(0));
  // 300+ byte key — S3 allows it, ustar alone cannot store it.
  store.set(
    `deposit-proofs/${'deep/'.repeat(30)}proof-${'x'.repeat(180)}.jpg`,
    Buffer.from('long-key-image')
  );
  // Not in a known bucket — must be ignored, never written anywhere.
  store.set('some-other-bucket/secret.txt', Buffer.from('nope'));
}

// ── tests ──────────────────────────────────────────────────────────────────
describe('one-file archive', () => {
  beforeEach(() => seedStore());

  it('builds an archive containing manifest, database and every image', async () => {
    const { manifest } = await buildPlatformArchive();
    // 'some-other-bucket' is not one of ours, so it must not be counted.
    expect(manifest.objects.count).toBe(4);
    expect(manifest.objects.buckets).toEqual(['deposit-proofs', 'user-avatars']);
    expect(manifest.counts.User).toBe(42);
    expect(manifest.parts['database.json']!.bytes).toBeGreaterThan(0);

    const file = await writeArchive();
    const listing = execFileSync('tar', ['-tzf', file]).toString().trim().split('\n');
    expect(listing).toContain('manifest.json');
    expect(listing).toContain('database.json');
    expect(listing).toContain('RESTORE.txt');
    expect(listing.filter((l) => l.startsWith('objects/deposit-proofs/'))).toHaveLength(3);
  });

  it('produces an archive that system tar can both list and extract byte-for-byte', async () => {
    const file = await writeArchive();
    const out = await newWorkDir();
    execFileSync('tar', ['-xzf', file, '-C', out]);
    const extracted = await readFile(join(out, 'database.json'), 'utf8');
    expect(JSON.parse(extracted)).toEqual(BUNDLE);
    expect(await readFile(join(out, 'objects/user-avatars/me.jpg'), 'utf8')).toBe('avatar-bytes');
    // The long key has to come out with the same name it went in with.
    const longKey = `deposit-proofs/${'deep/'.repeat(30)}proof-${'x'.repeat(180)}.jpg`;
    expect(await readFile(join(out, 'objects', longKey), 'utf8')).toBe('long-key-image');
  });

  it('round-trips through extractArchive with the manifest intact', async () => {
    const file = await writeArchive();
    const extracted = await extractArchive(file);
    expect(extracted.manifest?.objects.count).toBe(4);
    expect(JSON.parse(extracted.databaseJson.toString('utf8'))).toEqual(BUNDLE);
    expect(extracted.objects).toHaveLength(4);
    for (const obj of extracted.objects) {
      const original = store.get(`${obj.bucket}/${obj.key}`)!;
      expect(await readFile(obj.path)).toEqual(original);
    }
    await rm(extracted.workDir, { recursive: true, force: true });
  });

  it('restores every image and the database from one file', async () => {
    const file = await writeArchive();
    const before = new Map(store);

    // Wipe storage to prove the restore is what puts things back.
    store.clear();
    const result = await restorePlatformArchive(file);

    expect(result.tables).toEqual({ User: 1, Wallet: 0 });
    expect(result.objects).toEqual({ restored: 4, failed: 0, total: 4 });
    expect(store.size).toBe(4);
    for (const [k, v] of before) {
      // Only our own buckets are archived; 'some-other-bucket' must NOT return.
      if (k.startsWith('some-other-bucket/')) continue;
      expect(store.get(k)).toEqual(v);
    }
    // 'some-other-bucket' was never in the archive, so never restored.
    expect(restoreCalls.some((c) => c.startsWith('some-other-bucket/'))).toBe(false);
  });

  it('refuses an archive whose database.json was tampered with', async () => {
    const file = await writeArchive();
    const out = await newWorkDir();
    execFileSync('tar', ['-xzf', file, '-C', out]);
    await writeFile(join(out, 'database.json'), JSON.stringify({ version: 2, tables: {} }));
    const tampered = join(out, 'tampered.tar.gz');
    execFileSync('tar', ['-czf', tampered, '-C', out, 'manifest.json', 'database.json']);

    await expect(extractArchive(tampered)).rejects.toThrow(/Checksum mismatch/i);
    // 422 + a sentence the admin can act on — a plain Error would be masked to
    // "An unexpected error occurred" by the API's error handler.
    await expect(extractArchive(tampered)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a .tar.gz with no database.json instead of half-restoring', async () => {
    const out = await newWorkDir();
    await writeFile(join(out, 'manifest.json'), '{"format":"nope"}');
    const file = join(out, 'wrong.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', out, 'manifest.json']);

    await expect(extractArchive(file)).rejects.toThrow(/not a platform backup/i);
    await expect(extractArchive(file)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('ignores objects outside the known buckets and any path traversal', async () => {
    // A crafted archive: wrong bucket, and a key trying to escape the temp dir.
    const evil = { 'objects/deposit-proofs/x.jpg': 'ok' };
    const out = await newWorkDir();
    const objDir = join(out, 'objects', 'deposit-proofs');
    await mkdir(objDir, { recursive: true });
    await writeFile(join(out, 'database.json'), JSON.stringify(BUNDLE));
    await writeFile(join(objDir, 'x.jpg'), evil['objects/deposit-proofs/x.jpg']);
    await mkdir(join(out, 'objects', 'evil-bucket'), { recursive: true });
    await writeFile(join(out, 'objects', 'evil-bucket', 'secret.txt'), 'stolen');
    const file = join(out, 'evil.tar.gz');
    execFileSync('tar', [
      '-czf',
      file,
      '-C',
      out,
      'database.json',
      'objects/deposit-proofs/x.jpg',
      'objects/evil-bucket/secret.txt',
    ]);

    const extracted = await extractArchive(file);
    expect(extracted.objects).toEqual([
      expect.objectContaining({ bucket: 'deposit-proofs', key: 'x.jpg' }),
    ]);
    await rm(extracted.workDir, { recursive: true, force: true });

    // And the guard itself, on the names that would escape the directory:
    expect(parseObjectEntry('objects/deposit-proofs/../../etc/passwd')).toBeNull();
    expect(parseObjectEntry('objects/deposit-proofs//etc/passwd')).toBeNull();
    expect(parseObjectEntry('objects/evil-bucket/secret.txt')).toBeNull();
    expect(parseObjectEntry('objects/deposit-proofs/')).toBeNull();
    expect(parseObjectEntry('database.json')).toBeNull();
  });

  it('describes a backup without building it', async () => {
    const info = await describePlatformBackup();
    expect(info.objects.count).toBe(4);
    expect(info.keyFingerprint).toBe('deadbeefdeadbeef');
    expect(info.objects.bytes).toBeGreaterThan(0);
    expect(info.counts.Deposit).toBe(42);
  });

  it('still produces a usable archive when object storage is down', async () => {
    const minio = await import('../db/minio');
    const spy = vi
      .spyOn(minio.MinioClient, 'listObjectsV2')
      .mockImplementation(() => {
        throw new Error('S3 unreachable');
      });
    const file = await writeArchive();
    const extracted = await extractArchive(file);
    expect(extracted.objects).toHaveLength(0);
    expect(extracted.manifest?.objects.error).toMatch(/unreachable/);
    // The database is still there — a partial backup beats no backup.
    expect(JSON.parse(extracted.databaseJson.toString('utf8'))).toEqual(BUNDLE);
    await rm(extracted.workDir, { recursive: true, force: true });
    spy.mockRestore();
  });
});

describe('archive hygiene', () => {
  it('reports a damaged archive as a 422 the panel can display', async () => {
    const dir = await newWorkDir();
    const file = join(dir, 'truncated.tar.gz');
    const { stream } = await buildPlatformArchive();
    await pipeline(stream, createWriteStream(file));
    const full = await readFile(file);
    // Chop the gzip in half — the classic "the download did not finish".
    await writeFile(file, full.subarray(0, Math.floor(full.length / 2)));
    await expect(extractArchive(file)).rejects.toMatchObject({ statusCode: 422 });
    await expect(extractArchive(file)).rejects.toThrow(/could not be read as a backup archive/i);
  });

  it('leaves nothing behind in the temp directory after a failed restore', async () => {
    const before = new Set(await readdir(tmpdir()));
    await expect(restorePlatformArchive('/nonexistent/does-not-exist.tar.gz')).rejects.toThrow();
    const after = await readdir(tmpdir());
    const newDirs = after.filter((d) => d.startsWith('casino-archive-') && !before.has(d));
    expect(newDirs).toEqual([]);
  });

  it('names object entries by bucket and keeps keys verbatim', () => {
    expect(objectEntryName('deposit-proofs', 'a/b c.jpg')).toBe('objects/deposit-proofs/a/b c.jpg');
    expect(parseObjectEntry('objects/user-avatars/me.jpg')).toEqual({
      bucket: 'user-avatars',
      key: 'me.jpg',
    });
  });

  it('streams an upload to a temp file and reports its real size', async () => {
    const dir = await newWorkDir();
    const src = createReadStream(
      await (async () => {
        const f = join(await newWorkDir(), 'src.bin');
        await writeFile(f, Buffer.alloc(1024, 7));
        return f;
      })()
    );
    const path = await writeStreamToTempFile(src, dir);
    expect((await stat(path)).size).toBe(1024);
    await rm(path, { force: true });
  });
});

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});
