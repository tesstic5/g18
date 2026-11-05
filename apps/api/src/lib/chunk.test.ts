import { describe, expect, it, vi } from 'vitest';
import { chunk, insertRowsInBatches, INSERT_CHUNK } from './chunk';

describe('chunk', () => {
  it('splits rows into batches of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one batch when the input is smaller than the size', () => {
    expect(chunk([1, 2], 500)).toEqual([[1, 2]]);
  });

  it('returns nothing for empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('never exceeds the Postgres bind-parameter budget for a big table', () => {
    // 50k rows is a realistic restore; every batch must stay well under the
    // 65535-parameter ceiling even for a 30-column model.
    const rows = Array.from({ length: 50_000 }, (_, i) => i);
    const batches = chunk(rows, INSERT_CHUNK);
    expect(batches.length).toBe(100);
    expect(Math.max(...batches.map((b) => b.length))).toBe(INSERT_CHUNK);
    expect(batches.flat().length).toBe(50_000);
  });

  it('conserves every row, in order, for sizes that do not divide evenly', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => i);
    expect(chunk(rows, 250).flat()).toEqual(rows);
  });

  it('clamps a nonsensical size instead of looping forever', () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunk([1, 2, 3], -5)).toEqual([[1], [2], [3]]);
    expect(chunk([1, 2, 3], 1.9)).toEqual([[1], [2], [3]]);
  });

  it('does not mutate the input array', () => {
    const rows = [1, 2, 3];
    chunk(rows, 2);
    expect(rows).toEqual([1, 2, 3]);
  });
});

describe('insertRowsInBatches', () => {
  it('writes every row and reports the total', async () => {
    // Give the mock the real batch signature: `vi.fn(async () => undefined)`
    // types its calls as `[][]`, so `calls.map(([batch]) => …)` failed
    // `tsc --noEmit` (strict + noUncheckedIndexedAccess) in CI.
    const insert = vi.fn(async (_batch: Array<{ id: number }>) => undefined);
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i }));

    const written = await insertRowsInBatches(rows, insert, 500);

    expect(written).toBe(1200);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 200]);
  });

  it('passes rows through in order, with no duplicates or gaps', async () => {
    const seen: number[] = [];
    await insertRowsInBatches([1, 2, 3, 4, 5, 6, 7], async (batch) => {
      seen.push(...batch);
    }, 3);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('runs batches sequentially, never in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await insertRowsInBatches(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      3
    );
    expect(maxInFlight).toBe(1);
  });

  it('does not call the insert at all for an empty table', async () => {
    const insert = vi.fn(async () => undefined);
    expect(await insertRowsInBatches([], insert, 500)).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it('propagates a failed batch so the caller can roll back', async () => {
    const insert = vi.fn(async (batch: number[]) => {
      if (batch.includes(6)) throw new Error('P2002 unique constraint');
    });
    await expect(
      insertRowsInBatches([1, 2, 3, 4, 5, 6, 7], insert, 3)
    ).rejects.toThrow('P2002 unique constraint');
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
