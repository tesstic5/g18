// apps/api/src/services/backupArchive.ts — the panel's ONE-FILE backup.
//
//   database.json              the same AES-GCM bundle the JSON export produces
//   objects/<bucket>/<key>     every deposit proof + avatar, streamed from MinIO
//   manifest.json              row counts, sizes + sha256, key fingerprint
//   RESTORE.txt                what this file is and how to restore it
//
// Why an archive instead of "just the JSON": the JSON export never carried the
// uploaded images, so a restored platform showed deposits whose proof image was
// a broken link. Whoever held the database dump and the image folder had to keep
// two things in sync, and the pair was only ever correct by luck.
//
// The archive is streamed both ways: objects are piped from MinIO into the tar
// as they are read, and on restore each object is written to a temp file and
// uploaded from disk. Nothing holds all the images in memory at once.
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { TarPacker, readTar } from '../lib/tar';
import { exportJson, restoreJson, type BackupFile } from './backup';
import { currentKeyFingerprint } from '../lib/crypto-utils';
import { MinioClient, ensureBuckets } from '../db/minio';
import { prisma } from '../db/prisma';
import { AppError } from '../lib/core';
// NOTE: ERROR_CODES is NOT re-exported by lib/core — importing it from there
// yields undefined at runtime ("Cannot read properties of undefined (reading
// 'GEN_VALIDATION_ERROR')"). Every service imports it from the shared package.
import { ERROR_CODES } from '@casino/shared/constants/errors';

export const ARCHIVE_FORMAT = 'casino-platform-archive';
export const ARCHIVE_VERSION = 1;

/** Tables whose row counts go into the manifest — the bash scripts' list. */
const COUNT_TABLES = [
  'User',
  'Wallet',
  'GameRound',
  'Transaction',
  'Deposit',
  'Withdrawal',
  'AdminUser',
  'GameConfig',
] as const;

export interface ArchiveObjectInfo {
  bucket: string;
  key: string;
  size: number;
}

export interface ArchiveManifest {
  format: string;
  version: number;
  createdAt: string;
  source: 'panel';
  counts: Record<string, number>;
  parts: Record<string, { bytes: number; sha256: string }>;
  objects: {
    count: number;
    bytes: number;
    buckets: string[];
    /** Set when object storage could not be read: the archive then has no images. */
    error?: string;
  };
  encryption: { keyFingerprint: string; note: string };
  /** Filled by buildPlatformArchive: what the .tar.gz roughly weighs. */
  estimatedBytes?: number;
}

export function objectBuckets(): string[] {
  return [
    process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs',
    process.env.S3_BUCKET_AVATARS || 'user-avatars',
  ];
}

export function objectEntryName(bucket: string, key: string): string {
  return `objects/${bucket}/${key}`;
}

/** Inverse of objectEntryName. Returns null for anything unexpected. */
export function parseObjectEntry(name: string): { bucket: string; key: string } | null {
  if (!name.startsWith('objects/')) return null;
  const rest = name.slice('objects/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  // Never allow an extraction outside the target directory — a crafted archive
  // must not be able to write anywhere it likes.
  if (key.includes('..') || key.startsWith('/') || key.includes('\0')) return null;
  if (!objectBuckets().includes(bucket)) return null;
  return { bucket, key };
}

/**
 * A file the admin picked that cannot be restored.
 *
 * It MUST be an AppError with a 4xx status: lib/core.ts only forwards the
 * message of "operational" errors — anything else is masked to a generic 500
 * ("An unexpected error occurred"), which is exactly the kind of useless
 * message that makes people open a ticket instead of fixing their file.
 */
export function badBackupFile(message: string, cause?: unknown): AppError {
  const err = new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, message);
  if (cause) (err as AppError & { cause?: unknown }).cause = cause;
  return err;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    try {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c FROM "${table}"`
      )) as Array<{ c: number }>;
      counts[table] = Number(rows[0]?.c ?? 0);
    } catch {
      // A missing table must not abort the backup — record it as -1 so the
      // restore's comparison can see that it was never counted.
      counts[table] = -1;
    }
  }
  return counts;
}

/** Every stored object, with its size. Storage being down is not fatal here. */
export async function listStoredObjects(): Promise<{
  entries: ArchiveObjectInfo[];
  bytes: number;
  error?: string;
}> {
  const entries: ArchiveObjectInfo[] = [];
  let bytes = 0;
  try {
    for (const bucket of objectBuckets()) {
      const stream = MinioClient.listObjectsV2(bucket, '', true);
      for await (const item of stream) {
        const key = String(item.name ?? '');
        if (!key || key.endsWith('/')) continue;
        const size = Number(item.size ?? 0);
        entries.push({ bucket, key, size });
        bytes += size;
      }
    }
  } catch (err) {
    return { entries, bytes, error: (err as Error).message };
  }
  return { entries, bytes };
}

const RESTORE_TXT = `How to restore this platform backup
===================================

Fastest way (this platform's own admin panel):
  Admin panel -> Backup & Restore -> "Restore from a backup file" -> pick this file.
  It restores the database AND every uploaded image, then flushes caches.

    POST /panel/backup/restore-archive   (super-admin + step-up, body = this file)

Without the panel:
  1. gunzip + untar this file. You get:
       manifest.json    what is inside, with sizes and sha256 checksums
       database.json    the encrypted database bundle
       objects/         every deposit proof + avatar
       RESTORE.txt      this file
  2. Database: hand database.json to any deployment of this platform via
     PUT/POST /panel/backup/restore-json  (body: {"data": <database.json>, "confirm": "RESTORE"})
  3. Images: upload objects/<bucket>/<key> back into the matching MinIO bucket.

IMPORTANT: the restored platform needs the same ENCRYPTION_KEY that produced
database.json (see manifest.json -> encryption.keyFingerprint). Without it the
database restores fine but saved bank / mobile-wallet details cannot be read.
`;

export interface ArchiveDescription {
  generatedAt: string;
  counts: Record<string, number>;
  objects: { count: number; bytes: number; buckets: string[]; error?: string };
  keyFingerprint: string;
  /** Rough size of the finished .tar.gz — the panel warns before a long download. */
  estimatedBytes: number;
}

/**
 * Everything the panel needs to describe a backup BEFORE building it: how many
 * rows, how many images, which key. Cheap — no table is dumped, so the page can
 * show real numbers the moment it opens.
 */
export async function describePlatformBackup(): Promise<ArchiveDescription> {
  const listed = await listStoredObjects();
  const counts = await rowCounts();
  return {
    generatedAt: new Date().toISOString(),
    counts,
    objects: {
      count: listed.entries.length,
      bytes: listed.bytes,
      buckets: objectBuckets(),
      ...(listed.error ? { error: listed.error } : {}),
    },
    keyFingerprint: currentKeyFingerprint(),
    estimatedBytes: listed.bytes,
  };
}

/** Build the manifest for a set of parts, without touching storage. */
export function buildManifest(input: {
  counts: Record<string, number>;
  databaseJson: Buffer;
  objects: { count: number; bytes: number; buckets: string[]; error?: string };
  keyFingerprint: string;
  createdAt?: Date;
}): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    source: 'panel',
    counts: input.counts,
    parts: {
      'database.json': {
        bytes: input.databaseJson.length,
        sha256: sha256Hex(input.databaseJson),
      },
    },
    objects: input.objects,
    encryption: {
      keyFingerprint: input.keyFingerprint,
      note: 'sha256(ENCRYPTION_KEY) truncated to 16 hex chars. NOT reversible. A restore into a stack with a different ENCRYPTION_KEY leaves payout-account details unreadable.',
    },
  };
}

/**
 * Stream a complete platform archive. The returned stream is a gzip; the caller
 * pipes it straight to the HTTP response. Writing starts immediately and is
 * driven by the consumer's backpressure.
 */
export async function buildPlatformArchive(): Promise<{
  stream: Readable;
  manifest: ArchiveManifest;
}> {
  const bundle = await exportJson();
  const databaseJson = Buffer.from(JSON.stringify(bundle), 'utf8');
  const listed = await listStoredObjects();
  const counts = await rowCounts();
  const manifest = buildManifest({
    counts,
    databaseJson,
    objects: {
      count: listed.entries.length,
      bytes: listed.bytes,
      buckets: objectBuckets(),
      ...(listed.error ? { error: listed.error } : {}),
    },
    keyFingerprint: currentKeyFingerprint(),
  });
  manifest.estimatedBytes = manifest.parts['database.json']!.bytes + listed.bytes;

  const gzip = createGzip();
  const packer = new TarPacker(gzip);

  void (async () => {
    try {
      await packer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      await packer.addBuffer('database.json', databaseJson);
      for (const entry of listed.entries) {
        // A missing object mid-stream fails the whole archive on purpose: a
        // backup that quietly drops images is worse than one that stops and
        // says so.
        const object = await MinioClient.getObject(entry.bucket, entry.key);
        await packer.addStream(objectEntryName(entry.bucket, entry.key), entry.size, object);
      }
      await packer.addBuffer('RESTORE.txt', Buffer.from(RESTORE_TXT));
      await packer.finish();
    } catch (err) {
      gzip.destroy(err as Error);
      return;
    }
    gzip.end();
  })();

  return { stream: gzip, manifest };
}

export interface ArchiveExtract {
  manifest: ArchiveManifest | null;
  databaseJson: Buffer;
  objects: Array<{ bucket: string; key: string; path: string; bytes: number }>;
  workDir: string;
}

/**
 * Unpack an archive to a temp directory. Objects land on disk (not in memory),
 * the database bundle is returned as a buffer because it is parsed anyway.
 */
export async function extractArchive(filePath: string): Promise<ArchiveExtract> {
  const workDir = await mkdtemp(join(tmpdir(), 'casino-archive-'));
  const objectsDir = join(workDir, 'objects');
  let manifestRaw: string | null = null;
  let databaseJson: Buffer | null = null;
  const objects: ArchiveExtract['objects'] = [];

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);

  try {
    for await (const entry of readTar(gunzip)) {
      if (entry.name === 'manifest.json') {
        manifestRaw = entry.data.toString('utf8');
        continue;
      }
      if (entry.name === 'database.json') {
        databaseJson = entry.data;
        continue;
      }
      const parsed = parseObjectEntry(entry.name);
      if (!parsed) continue;
      const dest = join(objectsDir, parsed.bucket, parsed.key);
      if (!dest.startsWith(objectsDir + sep)) continue; // belt and braces
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, entry.data);
      objects.push({ ...parsed, path: dest, bytes: entry.size });
    }
  } catch (err) {
    await rm(workDir, { recursive: true, force: true });
    // gzip/tar-level damage: say what it means in words a human can act on,
    // and keep the technical reason for the log.
    if (err instanceof AppError) throw err;
    throw badBackupFile(
      'That file could not be read as a backup archive. It may be damaged, truncated, ' +
        'or not the file this platform produced — upload the .tar.gz exactly as it downloaded.',
      err
    );
  }

  if (!databaseJson) {
    await rm(workDir, { recursive: true, force: true });
    throw badBackupFile(
      'This file has no database.json inside it — it is not a platform backup archive.'
    );
  }

  let manifest: ArchiveManifest | null = null;
  if (manifestRaw) {
    try {
      manifest = JSON.parse(manifestRaw) as ArchiveManifest;
    } catch {
      manifest = null;
    }
    const expected = manifest?.parts?.['database.json']?.sha256;
    if (expected && expected !== sha256Hex(databaseJson)) {
      await rm(workDir, { recursive: true, force: true });
      throw badBackupFile(
        'Checksum mismatch: database.json does not match the checksum recorded when the ' +
          'backup was made, so the file is corrupt or was modified. Nothing was changed.'
      );
    }
  }

  return { manifest, databaseJson, objects, workDir };
}

export interface ArchiveRestoreResult {
  tables: Record<string, number>;
  objects: { restored: number; failed: number; total: number };
}

/**
 * Restore a platform archive: database first, then the images. Order matters —
 * if the database restore fails (wrong key, invalid bundle) nothing has been
 * touched, and the images cannot end up half-replaced by a failed restore.
 */
/** Where a restore has got to. Reported so the panel can show real progress. */
export interface RestoreProgress {
  stage: 'verifying' | 'database' | 'images';
  /** For `images`: how many objects are done, and how many there are. */
  done?: number;
  total?: number;
}

export async function restorePlatformArchive(
  filePath: string,
  onProgress?: (progress: RestoreProgress) => void
): Promise<ArchiveRestoreResult> {
  // The stage callback exists because a restore is now a background job: the
  // panel polls for progress instead of holding one long HTTP request open
  // (which proxies in front of the API are entitled to cut — see lib/backupJobs).
  // Callers that do not pass one (scripts, tests) behave exactly as before.
  onProgress?.({ stage: 'verifying' });
  const extracted = await extractArchive(filePath);
  try {
    const bundle = JSON.parse(extracted.databaseJson.toString('utf8')) as BackupFile;
    onProgress?.({ stage: 'database' });
    const tables = await restoreJson(bundle);

    let restored = 0;
    let failed = 0;
    if (extracted.objects.length) {
      onProgress?.({ stage: 'images', done: 0, total: extracted.objects.length });
      await ensureBuckets();
      for (const object of extracted.objects) {
        try {
          await MinioClient.fPutObject(object.bucket, object.key, object.path);
          restored += 1;
        } catch (err) {
          failed += 1;
          console.warn(
            `[backup] object restore failed for ${object.bucket}/${object.key}:`,
            (err as Error).message
          );
        }
        // Every 10 objects (and on the last one) so a 5 000-image restore does
        // not hammer Redis or the status endpoint with writes.
        if ((restored + failed) % 10 === 0 || restored + failed === extracted.objects.length) {
          onProgress?.({
            stage: 'images',
            done: restored + failed,
            total: extracted.objects.length,
          });
        }
      }
    }

    return { tables, objects: { restored, failed, total: extracted.objects.length } };
  } finally {
    await rm(extracted.workDir, { recursive: true, force: true });
  }
}

/**
 * Stream an upload to a temp file. The request body is never buffered in memory:
 * an archive can be gigabytes and the previous JSON route already had to raise
 * its body limit to 256 MiB just to be usable.
 */
export async function writeStreamToTempFile(stream: Readable, dir?: string): Promise<string> {
  const target = join(dir ?? tmpdir(), `casino-upload-${Date.now()}-${crypto.randomUUID()}.tar.gz`);
  await pipeline(stream, createWriteStream(target));
  return target;
}
