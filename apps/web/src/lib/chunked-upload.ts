// apps/web/src/lib/chunked-upload.ts — send a backup file as many small requests.
//
// WHY NOT ONE REQUEST: a platform archive is big, and the connection it travels
// over passes through Traefik (Dokploy) and the Next.js rewrite proxy before it
// reaches the API. Traefik's entrypoint read timeout defaults to 60s and is a
// deadline for the ENTIRE request including the body, so a slow upload gets cut
// mid-flight — the panel showed "Upload failed (HTTP 408)" at 99%, and nothing
// had been restored. A chunk request finishes in seconds, so no layer has a
// chance to cut it, and a chunk that does fail can simply be sent again.
//
// The loop lives here, free of React and of the API client, with the sender
// injected: that keeps it testable and lets lib/api.ts own the CSRF headers and
// the error envelope.

export interface ChunkPlan {
  /** Byte ranges to send, in order. */
  ranges: { offset: number; end: number }[];
}

/** Split `size` bytes into ranges of at most `chunkSize` bytes. */
export function planChunks(size: number, chunkSize: number): ChunkPlan {
  if (!Number.isFinite(size) || size <= 0) return { ranges: [] };
  const step = Math.max(1, Math.floor(chunkSize));
  const ranges: { offset: number; end: number }[] = [];
  for (let offset = 0; offset < size; offset += step) {
    ranges.push({ offset, end: Math.min(size, offset + step) });
  }
  return { ranges };
}

export interface ChunkSenderArgs {
  file: File;
  offset: number;
  blob: Blob;
  /** 1-based attempt number, so a sender can log/undo if it needs to. */
  attempt: number;
}

export type ChunkSender = (args: ChunkSenderArgs) => Promise<void>;

export interface ChunkedUploadOptions {
  /** Bytes per request. The server may clamp this; it is asked first. */
  chunkSize?: number;
  /** Fail a chunk after this many attempts (default 4, with backoff). */
  maxAttempts?: number;
  onProgress?: (percent: number, uploadedBytes: number, totalBytes: number) => void;
  /** Called after every chunk, so the UI can say "resuming…" etc. */
  onChunkDone?: (uploadedBytes: number, totalBytes: number) => void;
  /** Waits between retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is this error worth retrying? Network hiccups and 5xx/408 are; 4xx are not. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number } | null)?.status;
  const code = (err as { code?: string } | null)?.code ?? '';
  if (status === 408 || status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (!status) return true; // network/abort — the chunk never landed
  if (code === 'GEN_NETWORK' || code === 'GEN_TIMEOUT') return true;
  return false;
}

/**
 * Send every chunk in order, retrying the ones that fail. Resolves when the
 * whole file has been accepted by the server; the caller then asks the server to
 * finish (assemble) it. Progress is monotonic and never reports 100% until the
 * last chunk is acknowledged.
 */
export async function uploadInChunks(
  file: File,
  send: ChunkSender,
  opts: ChunkedUploadOptions = {}
): Promise<{ uploadedBytes: number; attempts: number }> {
  const chunkSize = opts.chunkSize ?? 8 * 1024 * 1024;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const sleep = opts.sleep ?? defaultSleep;
  const { ranges } = planChunks(file.size, chunkSize);

  let uploaded = 0;
  let attempts = 0;
  for (const range of ranges) {
    const blob = file.slice(range.offset, range.end);
    let lastError: unknown = null;
    let sent = false;
    for (let attempt = 1; attempt <= maxAttempts && !sent; attempt += 1) {
      attempts += 1;
      try {
        await send({ file, offset: range.offset, blob, attempt });
        sent = true;
      } catch (e) {
        lastError = e;
        if (!isRetryable(e) || attempt === maxAttempts) break;
        // A retried chunk is idempotent: the server checks the offset it already
        // holds, so resending the same bytes at the same position is safe and
        // never duplicates data.
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      }
    }
    if (!sent) throw lastError ?? new Error('Upload failed');
    uploaded = range.end;
    // Hold the bar just short of 100% until the server confirms the assembly.
    opts.onProgress?.(Math.min(99, Math.round((uploaded / file.size) * 99)), uploaded, file.size);
    opts.onChunkDone?.(uploaded, file.size);
  }
  return { uploadedBytes: uploaded, attempts };
}

/** Progress text worth showing while a long phase runs. */
export function describeUploadSpeed(bytes: number, seconds: number): string {
  if (!seconds) return '';
  const perSec = bytes / seconds;
  if (perSec > 1024 * 1024) return `${(perSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(perSec / 1024))} KB/s`;
}
