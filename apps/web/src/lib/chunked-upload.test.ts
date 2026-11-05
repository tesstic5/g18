// apps/web/src/lib/chunked-upload.test.ts
//
// The client half of the chunked restore upload. What matters here: the file is
// split exactly, a failed chunk is retried (a slow connection must not restart
// the whole upload), a refusal that will never succeed is NOT retried forever,
// and the progress bar never claims more than it has.
import { describe, expect, it, vi } from 'vitest';
import { isRetryable, planChunks, uploadInChunks, type ChunkSender } from './chunked-upload';

/** A File stand-in: only size + slice are used by the uploader. */
function fakeFile(size: number): File {
  const bytes = new Uint8Array(size).fill(65);
  return {
    size,
    slice: (start: number, end: number) => ({
      size: end - start,
      start,
      end,
    }),
  } as unknown as File;
}

const noSleep = async (): Promise<void> => undefined;

describe('planChunks', () => {
  it('splits a file into whole chunk ranges that cover it exactly once', () => {
    const { ranges } = planChunks(10, 4);
    expect(ranges).toEqual([
      { offset: 0, end: 4 },
      { offset: 4, end: 8 },
      { offset: 8, end: 10 },
    ]);
    expect(ranges.reduce((n, r) => n + (r.end - r.offset), 0)).toBe(10);
  });

  it('handles an exact multiple and a single-byte file', () => {
    expect(planChunks(8, 4).ranges).toHaveLength(2);
    expect(planChunks(1, 4).ranges).toEqual([{ offset: 0, end: 1 }]);
  });

  it('returns nothing for an empty file (the server refuses it later)', () => {
    expect(planChunks(0, 4).ranges).toEqual([]);
  });
});

describe('isRetryable', () => {
  it('retries timeouts, rate limits, server errors and network failures', () => {
    expect(isRetryable({ status: 408 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 502 })).toBe(true);
    expect(isRetryable({ code: 'GEN_NETWORK' })).toBe(true);
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not retry a refusal that cannot change on its own', () => {
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 413 })).toBe(false);
    expect(isRetryable({ status: 422 })).toBe(false);
  });
});

describe('uploadInChunks', () => {
  it('sends every chunk in order and reports progress monotonically', async () => {
    const file = fakeFile(10);
    const sent: number[] = [];
    const percents: number[] = [];
    const send: ChunkSender = async ({ offset, blob }) => {
      sent.push(offset);
      expect((blob as unknown as { size: number }).size).toBeLessThanOrEqual(4);
    };

    const res = await uploadInChunks(file, send, {
      chunkSize: 4,
      onProgress: (pct) => percents.push(pct),
      sleep: noSleep,
    });

    expect(sent).toEqual([0, 4, 8]);
    expect(res.uploadedBytes).toBe(10);
    expect(res.attempts).toBe(3);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(Math.max(...percents)).toBeLessThanOrEqual(99); // never claims done here
  });

  it('retries a failed chunk and finishes without resending the earlier ones', async () => {
    const file = fakeFile(12);
    const attempts: Record<number, number> = {};
    const send: ChunkSender = async ({ offset }) => {
      attempts[offset] = (attempts[offset] ?? 0) + 1;
      if (offset === 4 && attempts[offset] === 1) throw { status: 408 };
    };

    const res = await uploadInChunks(file, send, { chunkSize: 4, sleep: noSleep });
    expect(res.uploadedBytes).toBe(12);
    expect(attempts).toEqual({ 0: 1, 4: 2, 8: 1 });
    expect(res.attempts).toBe(4);
  });

  it('gives up after the attempt limit and surfaces the real error', async () => {
    const send: ChunkSender = async () => {
      throw { status: 503, message: 'service unavailable' };
    };
    await expect(
      uploadInChunks(fakeFile(8), send, { chunkSize: 4, maxAttempts: 2, sleep: noSleep })
    ).rejects.toMatchObject({ status: 503 });
  });

  it('stops at once on a permanent refusal instead of retrying it', async () => {
    const send = vi.fn(async () => {
      throw { status: 413 };
    });
    await expect(
      uploadInChunks(fakeFile(8), send, { chunkSize: 4, sleep: noSleep })
    ).rejects.toMatchObject({ status: 413 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('makes no request at all for an empty file', async () => {
    const send = vi.fn(async () => undefined);
    const res = await uploadInChunks(fakeFile(0), send, { chunkSize: 4, sleep: noSleep });
    expect(send).not.toHaveBeenCalled();
    expect(res.uploadedBytes).toBe(0);
  });
});
