// apps/api/src/services/backup.ts — JSON backup/restore of the entire platform
// (D-062). Used by the admin "Backup & Restore" page. pg_dump nightly snapshots
// live in scripts/backup.sh — this handles the human-friendly full export/import.
import { prisma } from '../db/prisma';
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { insertRowsInBatches, INSERT_CHUNK } from '../lib/chunk';
import { AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { TABLES, WIPE_ORDER } from './backupTables';

// A restore runs as ONE interactive transaction: `deleteMany` on every table,
// then re-insert. Prisma's default window is 5s, which a production-sized bundle
// blows through — and a restore killed MID-WIPE leaves the platform empty.
// Override RESTORE_TX_TIMEOUT_MS when a very large bundle needs longer.
const RESTORE_TX_TIMEOUT_MS = Number(process.env.RESTORE_TX_TIMEOUT_MS) || 15 * 60 * 1000;
// Lock acquisition against live traffic (the wipe needs exclusive access).
const RESTORE_TX_MAX_WAIT_MS = Number(process.env.RESTORE_TX_MAX_WAIT_MS) || 60 * 1000;

// Bundle keys use Prisma model names, while client delegates are lower camel-case.
// IMPORTANT: TABLES order = INSERT order → parents BEFORE children (FK-safe).
// WIPE_ORDER (below) = DELETE order → children BEFORE parents.




type Row = Record<string, unknown>;

/** Prisma delegates are lower camel-case (`prisma.user`, not `prisma.User`). */
export function delegateName(model: string): string {
  return model.slice(0, 1).toLowerCase() + model.slice(1);
}

export interface BackupBundle {
  version: 1;
  exportedAt: string;
  data: Partial<Record<(typeof TABLES)[number], Row[]>>;
}
export interface EncryptedBackup {
  version: 2;
  encrypted: true;
  exportedAt: string;
  payload: string;
}
export type BackupFile = BackupBundle | EncryptedBackup;

function validateBundle(value: unknown): BackupBundle {
  const bundle = value as BackupBundle;
  if (
    !bundle ||
    bundle.version !== 1 ||
    typeof bundle.exportedAt !== 'string' ||
    !bundle.data ||
    typeof bundle.data !== 'object'
  ) {
    throw new Error('Invalid backup file');
  }
  for (const [table, rows] of Object.entries(bundle.data)) {
    if (!(TABLES as readonly string[]).includes(table) || !Array.isArray(rows)) {
      throw new Error(`Invalid backup table: ${table}`);
    }
    if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`Invalid rows for backup table: ${table}`);
    }
  }
  return bundle;
}

/** Export every table inside an authenticated AES-256-GCM envelope. */
export async function exportJson(): Promise<EncryptedBackup> {
  const data: BackupBundle['data'] = {};
  for (const t of TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data[t] = (await (prisma as any)[delegateName(t)].findMany()) as Row[];
  }
  const bundle: BackupBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  };
  return {
    version: 2,
    encrypted: true,
    exportedAt: bundle.exportedAt,
    payload: encryptJson(bundle),
  };
}

/** Restore an encrypted v2 file (legacy v1 is accepted for migration). */
export async function restoreJson(file: BackupFile): Promise<Record<string, number>> {
  // Decrypt FIRST, before the transaction opens. A bundle exported by a
  // deployment with a different ENCRYPTION_KEY fails here — and since nothing
  // has been deleted yet, the operator's database is untouched. (Without this
  // catch the raw GCM error surfaced as "An unexpected error occurred", which
  // told the operator nothing about the real cause.)
  let decrypted: BackupBundle;
  try {
    decrypted =
      file?.version === 2 && file.encrypted
        ? decryptJson<BackupBundle>(file.payload)
        : (file as BackupBundle);
  } catch {
    throw new AppError(
      ERROR_CODES.GEN_VALIDATION_ERROR,
      422,
      'This backup file could not be decrypted — it was exported by a deployment ' +
        'using a different ENCRYPTION_KEY. Set ENCRYPTION_KEY to the value that ' +
        'produced the file, or use a pg_dump/pg_restore backup instead.'
    );
  }
  const bundle = validateBundle(decrypted);
  const counts: Record<string, number> = {};
  // H-11: restores of a production-scale dump blow straight through Prisma's
  // 5-second interactive-transaction default — a restore that dies MID-WIPE
  // leaves the platform half-empty. Give the operation its own window;
  // maxWait covers lock acquisition against live traffic.
  await prisma.$transaction(
    async (tx) => {
      // wipe every table in FK-safe order (children first)
      for (const t of WIPE_ORDER) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any)[delegateName(t)].deleteMany({});
      }
      // insert back — BATCHED. Prisma compiles createMany into ONE multi-row
      // INSERT, and PostgreSQL allows at most 65535 bind parameters per
      // statement; a production-sized table (50k users x ~25 columns) exceeded
      // that and the restore failed outright. insertRowsInBatches() keeps every
      // statement under the ceiling and returns the real row count.
      for (const t of TABLES) {
        const rows = bundle.data[t] ?? [];
        if (rows.length === 0) continue;
        counts[t] = await insertRowsInBatches(
          rows,
          (batch) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tx as any)[delegateName(t)].createMany({
              data: batch as never[],
              skipDuplicates: false,
            }),
          INSERT_CHUNK
        );
      }
    },
    { timeout: RESTORE_TX_TIMEOUT_MS, maxWait: RESTORE_TX_MAX_WAIT_MS }
  );
  // H-11: API/worker keep authoritative-ISH state in Redis (config cache,
  // leaderboards, chat feeds, round timers). After a restore the database and
  // Redis disagree — wipe Redis so the next read rehydrates from Postgres.
  // (BullMQ queue keys are flushed too; scheduled jobs re-enqueue at their
  // next tick. Acceptable: a restore is a planned maintenance event.)
  try {
    const { redis } = await import('../db/redis');
    await redis.flushdb();
  } catch (err) {
    console.error('[backup] post-restore redis flush failed:', (err as Error).message);
  }
  return counts;
}
