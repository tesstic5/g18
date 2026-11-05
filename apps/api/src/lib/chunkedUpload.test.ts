// apps/api/src/lib/chunkedUpload.test.ts
//
// The chunked upload exists because ONE long upload request is cut by the
// proxies in front of the API (see the module header). These cases pin the rules
// that make the chunking safe: byte-exact assembly, idempotent retries, order
// enforcement, the size ceiling, and no orphaned partial files.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abortUpload,
  appendChunk,
  appendChunkStream,
  archiveCeiling,
  createUpload,
  finishUpload,
  serverChunkBytes,
  sweepStaleUploads,
} from './chunkedUpload';
import { Readable } from 'node:stream';

const ORIGINAL = { BACKUP_MAX_ARCHIVE_BYTES: process.env.BACKUP_MAX_ARCHIVE_BYTES };
let dir: string;

/** A real gzip member header — finishUpload refuses anything else. */
function gzipBytes(size: number): Buffer {
  const buf = Buffer.alloc(size, 0x41);
  buf[0] = 0x1f;
  buf[1] = 0x8b;
  return buf;
}

async function status(e: unknown): Promise<number> {
  return (e as { statusCode?: number }).statusCode ?? 0;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chunk-test-'));
  delete process.env.BACKUP_MAX_ARCHIVE_BYTES;
});

afterEach(() => {
  if (ORIGINAL.BACKUP_MAX_ARCHIVE_BYTES === undefined) delete process.env.BACKUP_MAX_ARCHIVE_BYTES;
  else process.env.BACKUP_MAX_ARCHIVE_BYTES = ORIGINAL.BACKUP_MAX_ARCHIVE_BYTES;
});

describe('createUpload', () => {
  it('refuses an empty file with a sentence an operator can act on', async () => {
    const err = await createUpload(0, { dir }).catch((e) => e);
    expect(await status(err)).toBe(422);
    expect((err as Error).message).toMatch(/looks empty/i);
  });

  it('refuses a file above the ceiling and names the setting to raise', async () => {
    process.env.BACKUP_MAX_ARCHIVE_BYTES = String(1024 * 1024); // 1 MiB ceiling
    const err = await createUpload(5 * 1024 * 1024, { dir }).catch((e) => e);
    expect(await status(err)).toBe(413);
    expect((err as Error).message).toMatch(/BACKUP_MAX_ARCHIVE_BYTES/);
  });

  it('accepts a normal file and reports the chunk size the client should use', async () => {
    const up = await createUpload(1024, { dir });
    expect(up.received).toBe(0);
    expect(up.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(up.chunkSize).toBe(serverChunkBytes());
    expect(up.ceiling).toBe(archiveCeiling());
  });
});

describe('appendChunk', () => {
  it('assembles the file byte-for-byte from out-of-the-box chunks', async () => {
    const original = gzipBytes(10);
    const { uploadId } = await createUpload(original.length, { dir });
    const a = Buffer.from('hello ');
    const b = Buffer.from('world!');
    await appendChunk(uploadId, 0, a, { dir });
    const res = await appendChunk(uploadId, a.length, b, { dir });
    expect(res.received).toBe(12);
    const onDisk = await readFile(join(dir, `casino-chunk-${uploadId}.part`));
    expect(onDisk.toString()).toBe('hello world!');
  });

  it('treats a RETRIED chunk as a no-op instead of duplicating bytes', async () => {
    const { uploadId } = await createUpload(12, { dir });
    const a = Buffer.from('hello ');
    const b = Buffer.from('world!');
    await appendChunk(uploadId, 0, a, { dir });
    await appendChunk(uploadId, 6, b, { dir });
    // The client did not see the reply and sends chunk 1 again.
    const again = await appendChunk(uploadId, 0, a, { dir });
    expect(again.received).toBe(12);
    const onDisk = await readFile(join(dir, `casino-chunk-${uploadId}.part`));
    expect(onDisk.toString()).toBe('hello world!');
  });

  it('rejects a chunk that arrives before its turn (409) — never silently reorders', async () => {
    const { uploadId } = await createUpload(12, { dir });
    const err = await appendChunk(uploadId, 6, Buffer.from('world!'), { dir }).catch((e) => e);
    expect(await status(err)).toBe(409);
    expect((err as Error).message).toMatch(/gap/i);
  });

  it('rejects an unknown upload id (410) and never touches the filesystem', async () => {
    const err = await appendChunk('11111111-2222-3333-4444-555555555555', 0, Buffer.from('x'), {
      dir,
    }).catch((e) => e);
    expect(await status(err)).toBe(410);
  });

  it('rejects a malformed upload id (422) before building any path', async () => {
    const err = await appendChunk('../../etc/passwd', 0, Buffer.from('x'), { dir }).catch((e) => e);
    expect(await status(err)).toBe(422);
    expect((err as Error).message).toMatch(/upload id is not valid/i);
  });

  it('stops at the ceiling and removes the partial file', async () => {
    process.env.BACKUP_MAX_ARCHIVE_BYTES = String(10);
    const { uploadId } = await createUpload(10, { dir });
    const err = await appendChunk(uploadId, 0, Buffer.alloc(11, 1), { dir }).catch((e) => e);
    expect(await status(err)).toBe(413);
    await expect(readFile(join(dir, `casino-chunk-${uploadId}.part`))).rejects.toThrow();
  });
});

describe('appendChunkStream (what the route uses)', () => {
  it('streams a chunk onto the partial file at the right offset', async () => {
    const { uploadId } = await createUpload(20, { dir });
    await appendChunkStream(uploadId, 0, Readable.from([Buffer.from('12345')]), { dir });
    const res = await appendChunkStream(uploadId, 5, Readable.from([Buffer.from('67890')]), { dir });
    expect(res.received).toBe(10);
    expect((await readFile(join(dir, `casino-chunk-${uploadId}.part`))).toString()).toBe('1234567890');
  });

  it('accepts a RESENT chunk as a no-op (the client never saw the reply)', async () => {
    const { uploadId } = await createUpload(20, { dir });
    await appendChunkStream(uploadId, 0, Readable.from([Buffer.from('12345')]), { dir });
    await appendChunkStream(uploadId, 5, Readable.from([Buffer.from('67890')]), { dir });
    // The reply for the second chunk was lost, so the browser sends it again.
    const again = await appendChunkStream(uploadId, 5, Readable.from([Buffer.from('67890')]), {
      dir,
    });
    expect(again.received).toBe(10);
    expect((await readFile(join(dir, `casino-chunk-${uploadId}.part`))).toString()).toBe('1234567890');
  });

  it('appends only the unseen tail of a partially-overlapping retry', async () => {
    const { uploadId } = await createUpload(20, { dir });
    await appendChunkStream(uploadId, 0, Readable.from([Buffer.from('12345678')]), { dir });
    // A different chunk plan resent from offset 4 — the first 4 bytes are
    // duplicates, the rest is new data and must land at the end.
    const res = await appendChunkStream(uploadId, 4, Readable.from([Buffer.from('5678ABCD')]), {
      dir,
    });
    expect(res.received).toBe(12);
    expect((await readFile(join(dir, `casino-chunk-${uploadId}.part`))).toString()).toBe(
      '12345678ABCD'
    );
  });

  it('refuses a stream that starts beyond what we hold, and drains it (no hang)', async () => {
    const { uploadId } = await createUpload(20, { dir });
    const stream = Readable.from([Buffer.from('x'.repeat(1024))]);
    const err = await appendChunkStream(uploadId, 5, stream, { dir }).catch((e) => e);
    expect(await status(err)).toBe(409);
    // Drained: `readableEnded` only becomes true if somebody consumed it.
    await new Promise((r) => setTimeout(r, 5));
    expect(stream.readableEnded || stream.destroyed).toBe(true);
  });

  it('caps a single request, so a "chunk" can never become the whole file again', async () => {
    const { uploadId } = await createUpload(serverChunkBytes() * 3, { dir });
    const tooBig = Buffer.alloc(serverChunkBytes() + 512 * 1024, 7);
    const err = await appendChunkStream(uploadId, 0, Readable.from([tooBig]), { dir }).catch((e) => e);
    expect(await status(err)).toBe(413);
    expect((err as Error).message).toMatch(/smaller chunks/i);
  });
});

describe('finishUpload', () => {
  it('hands back a tempPath the archive restore accepts, sized exactly', async () => {
    const payload = gzipBytes(64);
    const { uploadId } = await createUpload(payload.length, { dir });
    await appendChunk(uploadId, 0, payload, { dir });
    const done = await finishUpload(uploadId, { dir });
    expect(done.bytes).toBe(64);
    expect(done.tempPath).toMatch(/casino-upload-.*\.tar\.gz$/);
    expect((await readFile(done.tempPath)).equals(payload)).toBe(true);
  });

  it('rejects a non-gzip file at the door, with a sentence that says what to do', async () => {
    const { uploadId } = await createUpload(10, { dir });
    await appendChunk(uploadId, 0, Buffer.from('not a backup'), { dir });
    const err = await finishUpload(uploadId, { dir }).catch((e) => e);
    expect(await status(err)).toBe(422);
    expect((err as Error).message).toMatch(/not a platform backup/i);
  });

  it('refuses an empty upload instead of restoring nothing', async () => {
    const { uploadId } = await createUpload(10, { dir });
    const err = await finishUpload(uploadId, { dir }).catch((e) => e);
    expect(await status(err)).toBe(422);
    expect((err as Error).message).toMatch(/nothing was restored/i);
  });
});

describe('abortUpload + sweepStaleUploads', () => {
  it('abort removes the partial file', async () => {
    const { uploadId } = await createUpload(10, { dir });
    await appendChunk(uploadId, 0, gzipBytes(4), { dir });
    await abortUpload(uploadId, { dir });
    await expect(readFile(join(dir, `casino-chunk-${uploadId}.part`))).rejects.toThrow();
  });

  it('sweeps abandoned uploads and leaves live ones alone', async () => {
    const stale = await createUpload(10, { dir });
    await appendChunk(stale.uploadId, 0, gzipBytes(4), { dir });
    const fresh = await createUpload(10, { dir });
    // Age the stale file by writing an old mtime through a touch-like write.
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await utimes(join(dir, `casino-chunk-${stale.uploadId}.part`), old, old);

    const removed = await sweepStaleUploads({ dir });
    expect(removed).toBe(1);
    await expect(readFile(join(dir, `casino-chunk-${stale.uploadId}.part`))).rejects.toThrow();
    // The fresh one is still there.
    await expect(readFile(join(dir, `casino-chunk-${fresh.uploadId}.part`))).resolves.toBeTruthy();
  });

  it('never deletes files it did not create', async () => {
    const decoy = join(dir, 'something-else.part');
    await writeFile(decoy, 'leave me');
    await sweepStaleUploads({ dir, maxAgeMs: 0 });
    expect(await readFile(decoy, 'utf8')).toBe('leave me');
  });
});
