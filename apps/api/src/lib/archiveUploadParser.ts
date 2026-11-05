// apps/api/src/lib/archiveUploadParser.ts
//
// The content-type parser for platform-backup uploads.
//
// It exists because of two Fastify behaviours that are easy to get wrong:
//
//   1. A custom content-type parser receives the RAW stream. Fastify enforces
//      `bodyLimit` only for its own parsers (and multipart), so a route-level
//      `bodyLimit` is silently ignored here — measured: a 9 KB body sailed past
//      both a 1 KB global and a 2 KB route limit. The limit below is therefore
//      enforced by THIS code, reading the route's declared limit itself.
//      Without it, a restore upload could write until the disk filled.
//
//   2. Buffering the body is not an option. A platform archive holds the
//      database plus every uploaded image, so the body goes straight to a temp
//      file as it arrives and the route only ever sees `{ tempPath, bytes }`.
//
// Partial files from a failed or oversized upload are removed immediately —
// a rejected restore must not leave gigabytes behind in /tmp.
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';

/** Used when neither the route nor the environment declares a ceiling. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface ArchiveUploadBody {
  /** Where the uploaded archive is sitting, ready to be read. */
  tempPath: string;
  bytes: number;
}

type Done = (err: Error | null, body?: ArchiveUploadBody) => void;

export function archiveUploadLimit(request: FastifyRequest): number {
  const route = (request as unknown as { routeOptions?: { bodyLimit?: number } }).routeOptions
    ?.bodyLimit;
  if (typeof route === 'number' && Number.isFinite(route) && route > 0) return route;
  const env = Number(process.env.BACKUP_MAX_ARCHIVE_BYTES);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_ARCHIVE_MAX_BYTES;
}

/** Shaped like Fastify's own limit error so the client sees a normal 413. */
export function tooLargeError(limit: number): Error {
  const mb = Math.max(1, Math.round(limit / 1024 / 1024));
  const err = new Error(
    `That backup file is larger than the ${mb} MB this server accepts for a restore. ` +
      'Raise BACKUP_MAX_ARCHIVE_BYTES on the API service to allow it.'
  ) as Error & { statusCode?: number; code?: string };
  err.statusCode = 413;
  err.code = 'FST_ERR_CTP_BODY_TOO_LARGE';
  return err;
}

/**
 * Returns a Fastify content-type parser. `dir` is injectable so tests can point
 * it at a scratch directory.
 */
export function createArchiveUploadParser(opts: { dir?: string } = {}) {
  const dir = opts.dir ?? tmpdir();

  return function archiveUploadParser(request: FastifyRequest, payload: Readable, done: Done): void {
    const limit = archiveUploadLimit(request);

    // Cheap early out: if the client declared a size, believe it and refuse
    // before creating (or filling) a file at all.
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      payload.resume?.();
      done(tooLargeError(limit));
      return;
    }

    const tempPath = join(dir, `casino-upload-${Date.now()}-${randomUUID()}.tar.gz`);
    const out = createWriteStream(tempPath);
    let bytes = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      out.destroy();
      void rm(tempPath, { force: true }).catch(() => undefined);
      // Keep draining so the socket does not stall while the error reply goes
      // out; the client aborts as soon as it sees the 413.
      payload.unpipe?.(out);
      payload.resume?.();
      done(err);
    };

    payload.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      // Byte accounting, not Content-Length: a chunked upload declares nothing.
      if (bytes > limit) fail(tooLargeError(limit));
    });
    payload.on('error', (err: Error) => fail(err));
    out.on('error', (err) => fail(err));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      done(null, { tempPath, bytes });
    });
    payload.pipe(out);
  };
}
