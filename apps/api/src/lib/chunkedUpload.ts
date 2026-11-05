// apps/api/src/lib/chunkedUpload.ts — resumable, chunked backup uploads.
//
// WHY THIS EXISTS
// ---------------
// The panel used to upload a platform archive as ONE long request (the .tar.gz
// as the request body) and the API restored it before answering. That request
// stays open for minutes on a real connection, and it crosses several hops that
// each get to impose their own limit:
//
//   browser → Traefik (Dokploy) → web container (Next rewrite proxy) → api
//
// Traefik's entrypoint `respondingTimeouts.readTimeout` defaults to 60s and is
// documented as bounding the time to read the ENTIRE request *including its
// body* — it is enforced as a deadline on the connection, so a slow upload is
// cut even while data is flowing. Field reports show exactly our symptom: the
// upload reaches ~99%, then Traefik answers 408 with OriginStatus 0 (the backend
// never replied) — and the panel showed a bare "Upload failed (HTTP 408)".
// Raising the timeout is not reliable (same reports show it changing nothing on
// some setups) and it is a change to infrastructure the app cannot make for the
// operator.
//
// So the upload no longer needs one long request: the file is sent as a series
// of small chunks, each a request that finishes in seconds. Any single chunk can
// be retried, which also makes the transfer resumable — a real benefit for a
// multi-gigabyte archive on a home uplink.
//
// The route handlers live in routes/panel.ts; this module is the file handling
// and the offset/limits rules, kept free of Fastify so it can be unit-tested.
import { createWriteStream } from 'node:fs';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { DEFAULT_ARCHIVE_MAX_BYTES } from './archiveUploadParser';

/** Size of one chunk when the client does not choose one. 8 MiB keeps a chunk
 *  request in the low seconds even on a slow uplink. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Smallest/largest chunk a client may ask for. */
export const MIN_CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** Extra room a chunk request may carry on top of the chunk itself. */
export const CHUNK_REQUEST_SLACK_BYTES = 256 * 1024;

/** Abandoned uploads are swept after this long (a restore never takes 6h). */
export const UPLOAD_STALE_MS = 6 * 60 * 60 * 1000;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChunkedUploadRef {
  uploadId: string;
  received: number;
}

/** The largest archive this server accepts — same ceiling as a single-shot upload. */
export function archiveCeiling(): number {
  const env = Number(process.env.BACKUP_MAX_ARCHIVE_BYTES);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_ARCHIVE_MAX_BYTES;
}

/** The chunk size this server will accept, clamped to a sane window. */
export function serverChunkBytes(): number {
  const env = Number(process.env.BACKUP_UPLOAD_CHUNK_BYTES);
  if (!Number.isFinite(env) || env <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(env)));
}

function uploadDir(dir?: string): string {
  return dir ?? tmpdir();
}

function partPathFor(dir: string, uploadId: string): string {
  if (!ID_RE.test(uploadId)) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'That upload id is not valid — start the upload again.'
    );
  }
  return join(dir, `casino-chunk-${uploadId}.part`);
}

function mb(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1024 / 1024));
}

/**
 * Delete leftovers from uploads that were abandoned (browser closed, network
 * died). Called on every init so a stuck upload can never fill the disk.
 */
export async function sweepStaleUploads(
  opts: { dir?: string; maxAgeMs?: number; now?: number } = {}
): Promise<number> {
  const dir = uploadDir(opts.dir);
  const maxAge = opts.maxAgeMs ?? UPLOAD_STALE_MS;
  const now = opts.now ?? Date.now();
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!/^casino-chunk-[0-9a-f-]{36}\.part$/.test(name)) continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (now - s.mtimeMs > maxAge) {
          await rm(full, { force: true });
          removed += 1;
        }
      } catch {
        /* raced with another sweep — ignore */
      }
    }
  } catch {
    /* an unreadable temp dir must not break a restore */
  }
  return removed;
}

/**
 * Start an upload. The declared size is only used to refuse early — the total is
 * verified byte by byte as chunks arrive, because a client can lie (and a
 * chunked request declares nothing at all).
 */
export async function createUpload(
  size: number,
  opts: { dir?: string } = {}
): Promise<ChunkedUploadRef & { chunkSize: number; ceiling: number }> {
  const ceiling = archiveCeiling();
  if (!Number.isFinite(size) || size <= 0) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'That backup file looks empty — nothing to upload.'
    );
  }
  if (size > ceiling) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      413,
      `That backup file is ${mb(size)} MB, larger than the ${mb(ceiling)} MB this server accepts. ` +
        'Raise BACKUP_MAX_ARCHIVE_BYTES on the API service to allow it.'
    );
  }
  await sweepStaleUploads({ dir: opts.dir });
  const uploadId = randomUUID();
  // Create the file now, so "received" means the file's real size from the start.
  const out = createWriteStream(partPathFor(uploadDir(opts.dir), uploadId));
  await new Promise<void>((resolve, reject) => {
    out.on('open', () => {
      out.close(() => resolve());
    });
    out.on('error', reject);
  });
  return { uploadId, received: 0, chunkSize: serverChunkBytes(), ceiling };
}

async function partSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      410,
      'That upload is no longer available — start the restore again.'
    );
  }
}

/**
 * Append one chunk at `offset`. The offset must be exactly what the server has
 * already stored: that is what makes a retried chunk idempotent instead of
 * silently duplicating data, and it rejects a genuinely out-of-order stream.
 */
export async function appendChunk(
  uploadId: string,
  offset: number,
  data: Buffer,
  opts: { dir?: string } = {}
): Promise<{ received: number }> {
  const dir = uploadDir(opts.dir);
  const path = partPathFor(dir, uploadId);
  const have = await partSize(path);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'That chunk arrived without a position — start the restore again.'
    );
  }
  if (offset > have) {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      409,
      `Chunk gap: this chunk starts at byte ${offset} but the server has ${have}. Restart the upload.`
    );
  }
  if (offset < have) {
    // Already have it: a retried chunk. Idempotent by design.
    const overlap = offset + data.length;
    if (overlap <= have) return { received: have };
    data = data.subarray(have - offset);
    offset = have;
  }
  const ceiling = archiveCeiling();
  if (have + data.length > ceiling) {
    await rm(path, { force: true });
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      413,
      `That backup file is larger than the ${mb(ceiling)} MB this server accepts for a restore. ` +
        'Raise BACKUP_MAX_ARCHIVE_BYTES on the API service to allow it.'
    );
  }

  const handle = await open(path, 'r+');
  try {
    await handle.write(data, 0, data.length, offset);
  } finally {
    await handle.close();
  }
  return { received: offset + data.length };
}

/**
 * Same as appendChunk but streams the request body straight to disk.
 *
 * A chunk that starts AT what we already hold is appended; a chunk that starts
 * BEFORE it is a retry — the client resent bytes we have because it never saw
 * the reply — so the part we already stored is skipped and only the remainder is
 * appended. That makes the endpoint idempotent for the client, which is what
 * lets it retry a dropped chunk instead of restarting a 2 GB upload. (Found by
 * the end-to-end run: a resent final chunk was refused as "out of order".)
 */
export async function appendChunkStream(
  uploadId: string,
  offset: number,
  stream: Readable,
  opts: { dir?: string } = {}
): Promise<{ received: number }> {
  const dir = uploadDir(opts.dir);
  const path = partPathFor(dir, uploadId);
  const have = await partSize(path);

  if (!Number.isFinite(offset) || offset < 0) {
    stream.resume?.();
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'That chunk arrived without a position — start the restore again.'
    );
  }
  if (offset > have) {
    stream.resume?.();
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      409,
      `Chunk gap: this chunk starts at byte ${offset} but the server has ${have}. Restart the upload.`
    );
  }

  let toSkip = have - offset; // > 0 only for a retried chunk
  const start = have;
  const ceiling = archiveCeiling();
  // The request itself is capped too: a "chunk" that is really the whole file
  // would put us right back to one long request that a proxy can cut, which is
  // the entire reason this endpoint exists.
  const maxRequest = serverChunkBytes() + CHUNK_REQUEST_SLACK_BYTES;
  let appended = 0;

  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb: (e?: Error | null, d?: Buffer) => void) {
      let data = chunk;
      if (toSkip > 0) {
        const drop = Math.min(toSkip, data.length);
        toSkip -= drop;
        data = data.subarray(drop);
      }
      if (!data.length) {
        cb();
        return;
      }
      appended += data.length;
      if (appended > maxRequest) {
        cb(
          new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            413,
            `That chunk is larger than the ${mb(maxRequest)} MB this server accepts in one piece — ` +
              'send the file in smaller chunks.'
          )
        );
        return;
      }
      if (start + appended > ceiling) {
        cb(
          new AppError(
            ERROR_CODES.GEN_VALIDATION_ERROR,
            413,
            `That backup file is larger than the ${mb(ceiling)} MB this server accepts for a restore.`
          )
        );
        return;
      }
      cb(null, data);
    },
  });

  const out = createWriteStream(path, { flags: 'r+', start });
  try {
    await pipeline(stream, gate, out);
  } catch (e) {
    await rm(path, { force: true }).catch(() => undefined);
    throw e;
  }
  return { received: start + appended };
}

/**
 * Finish the upload: the assembled file is moved to the same `casino-upload-*`
 * name the single-shot parser produces, so the existing archive restore path
 * accepts it unchanged.
 */
export async function finishUpload(
  uploadId: string,
  opts: { dir?: string } = {}
): Promise<{ tempPath: string; bytes: number }> {
  const dir = uploadDir(opts.dir);
  const part = partPathFor(dir, uploadId);
  const bytes = await partSize(part);
  if (bytes === 0) {
    await rm(part, { force: true });
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'No data arrived for that file — the upload was empty, so nothing was restored.'
    );
  }
  // A gzip member always starts with 0x1f 0x8b. Checking here costs nothing and
  // turns "wrong file" into a clear answer instead of a checksum failure later.
  const head = Buffer.alloc(2);
  const handle = await open(part, 'r');
  try {
    await handle.read(head, 0, 2, 0);
  } finally {
    await handle.close();
  }
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    await rm(part, { force: true });
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'That file is not a platform backup — it is not a .tar.gz produced by the download button on this page.'
    );
  }
  const tempPath = join(dir, `casino-upload-${Date.now()}-${randomUUID()}.tar.gz`);
  await rename(part, tempPath);
  return { tempPath, bytes };
}

/** Client gave up (or the admin cancelled) — remove the partial file. */
export async function abortUpload(uploadId: string, opts: { dir?: string } = {}): Promise<void> {
  await rm(partPathFor(uploadDir(opts.dir), uploadId), { force: true });
}
