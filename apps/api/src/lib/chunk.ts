// apps/api/src/lib/chunk.ts — batching helpers for large writes.
//
// WHY: PostgreSQL accepts at most 65535 bind parameters in ONE statement. Prisma
// compiles `createMany({ data: rows })` into a single multi-row INSERT, so a
// restore of a production-sized table blows straight through that ceiling:
//
//   bind message supplies 20000 parameters, but prepared statement requires 90000
//
// A `User` row carries ~25 columns, so the real limit is ~2600 rows per
// statement — i.e. a JSON backup with 50k users could never be restored. The
// value is deliberately conservative: fewer binds per statement is slower but
// never fails, and a restore is a rare, planned operation.
export const INSERT_CHUNK = 500;

/** Split `rows` into batches of at most `size` (size >= 1). Never mutates input. */
export function chunk<T>(rows: readonly T[], size: number = INSERT_CHUNK): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step) as T[]);
  return out;
}

/**
 * Insert `rows` through `insert`, `size` rows at a time, and return how many
 * rows were written. Batches run sequentially: a restore holds a single
 * transaction, and parallel INSERTs inside it would deadlock on the same table.
 *
 * Errors propagate to the caller (which owns the transaction), so a failure
 * rolls the whole restore back rather than leaving a half-populated database.
 */
export async function insertRowsInBatches<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<unknown>,
  size: number = INSERT_CHUNK
): Promise<number> {
  let written = 0;
  for (const batch of chunk(rows, size)) {
    await insert(batch);
    written += batch.length;
  }
  return written;
}
