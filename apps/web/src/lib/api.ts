// apps/web/src/lib/api.ts — typed fetch wrapper.
// Canonical: docs/19 §7 bet lifecycle (8s timeout, bet-status recovery),
// docs/20 §1 (X-Request-ID, X-CSRF-Token), silent refresh + 401 queue (docs/22 §refresh).
import type { SettledRoundResult } from '@casino/shared/types';
import { useAuthStore } from '../stores';
import { betStatusDto } from './dto';
import { apiBaseUrl } from './env';
import { safeStorage } from './safe-storage';
import { uploadInChunks, type ChunkSender } from './chunked-upload';

const BASE = apiBaseUrl();
const DEMO_SESSION_KEY = 'demo_session_id';
function demoSessionId(): string {
  const existing = safeStorage.get(DEMO_SESSION_KEY);
  if (existing) return existing;
  const created = uuid();
  safeStorage.set(DEMO_SESSION_KEY, created);
  return created;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public refunded?: boolean,
    public details?: unknown
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number; // default 15s; bets use 8s (docs/19 §7)
  signal?: AbortSignal; // AbortController on unmount (docs/22 §abort)
  skipAuth?: boolean;
  demo?: boolean; // X-Demo-Mode header (v7 §9)
  /** Uniform response validation: when set, the success payload is parsed
   *  through this zod schema and a malformed body fails loudly (GEN_DTO)
   *  instead of poisoning downstream components with typed garbage. */
  schema?: { safeParse: (data: unknown) => { success: boolean; data?: unknown } };
}

let refreshPromise: Promise<boolean> | null = null;

/** In-memory CSRF token. Cross-origin deploys set csrf_token on the API host,
 *  so document.cookie on the web origin is empty even though the cookie IS
 *  sent. Login / /auth/me / /panel/auth/me return the value; we echo it. */
let csrfMem = '';

export function rememberCsrf(token?: string | null): void {
  if (token && token.length >= 16) csrfMem = token;
}

export function forgetCsrf(): void {
  csrfMem = '';
}

function cookieCsrf(): string {
  if (typeof document === 'undefined') return '';
  return (
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('csrf_token='))
      ?.split('=')[1] ?? ''
  );
}

function readCsrf(): string {
  return csrfMem || cookieCsrf();
}

function captureCsrf(res: Response, data: unknown): void {
  rememberCsrf(res.headers.get('x-csrf-token'));
  if (data && typeof data === 'object' && 'csrfToken' in data) {
    rememberCsrf((data as { csrfToken?: string }).csrfToken);
  }
}

/** GET /auth/me or /panel/auth/me to mint/echo a CSRF token, then retry. */
async function healCsrf(path: string): Promise<void> {
  const mePath = path.startsWith('/panel') ? '/panel/auth/me' : '/auth/me';
  const headers: Record<string, string> = {};
  const token = useAuthStore.getState().accessToken;
  if (token && !path.startsWith('/panel')) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${mePath}`, { credentials: 'include', headers });
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  captureCsrf(res, json?.data);
}

/** Single-flight silent refresh (docs/22 §refresh): concurrent 401s share one refresh. */
function refreshAccessToken(): Promise<boolean> {
  // No token = guest — nothing to refresh (D-063: prevents guest 401s from
  // triggering the logout redirect loop).
  if (!useAuthStore.getState().accessToken) return Promise.resolve(false);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      let response = await fetch(`${BASE}/auth/refresh-token`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.status === 409) {
        // Another tab rotated the cookie. Give its Set-Cookie a moment to land,
        // then exchange the new family; never turn a legitimate race into logout.
        await new Promise((resolve) => setTimeout(resolve, 150));
        response = await fetch(`${BASE}/auth/refresh-token`, {
          method: 'POST',
          credentials: 'include',
        });
      }
      if (!response.ok) return false;
      const json = (await response.json().catch(() => null)) as {
        data?: { accessToken?: string };
      } | null;
      const token = json?.data?.accessToken;
      if (!token) return false;
      useAuthStore.getState().setSession(useAuthStore.getState().user, token);
      return true;
    })()
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    timeoutMs = 15000,
    signal,
    skipAuth = false,
    demo = false,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  // link external abort (unmount) to our controller
  signal?.addEventListener('abort', () => controller.abort(signal.reason));

  const requestId = uuid();
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
      'X-CSRF-Token': readCsrf(),
    };
    // D-080: only set Content-Type when there IS a body. Fastify rejects
    // `Content-Type: application/json` with an EMPTY body ("Body cannot be
    // empty…") — this was breaking every body-less POST: the daily bonus
    // claim, seed rotation, read-all, logout.
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = useAuthStore.getState().accessToken;
    if (token && !skipAuth) headers.Authorization = `Bearer ${token}`;
    if (demo) {
      headers['X-Demo-Mode'] = 'true';
      headers['X-Demo-Session'] = demoSessionId();
    }

    return fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  try {
    let res = await attempt();
    if (res.status === 403 && method !== 'GET') {
      const peeked = (await res
        .clone()
        .json()
        .catch(() => null)) as {
        code?: string;
      } | null;
      if (peeked?.code === 'CSRF_INVALID') {
        await healCsrf(path).catch(() => {});
        res = await attempt();
      }
    }
    if (res.status === 401 && !skipAuth) {
      // silent refresh once, then retry (docs/22 §401)
      const refreshed = await refreshAccessToken();
      if (refreshed) res = await attempt();
      // D-063: only force-logout when there WAS a session. A guest hitting an
      // authed endpoint must just get the 401 error, NOT be bounced to /login.
      else if (useAuthStore.getState().accessToken) {
        useAuthStore.getState().logout();
        throw new ApiError('AUTH_002', 401, 'Session expired');
      }
    }
    const json = (await res.json().catch(() => null)) as {
      success: boolean;
      data?: T;
      message?: string;
      code?: string;
      refunded?: boolean;
      details?: unknown;
      requestId?: string;
    };
    captureCsrf(res, json?.data);
    if (!res.ok || !json?.success) {
      // D-103: surface the server's requestId so the UI can show a reference
      // ("ref: …") for support when an unexpected error happens.
      const details =
        json?.details && typeof json.details === 'object'
          ? { ...(json.details as object), requestId: json?.requestId }
          : { requestId: json?.requestId };
      // A response with no `message` did not come from our API — the API's
      // error handler ALWAYS fills that field. It means something in front of
      // the API answered instead: on a Dokploy/Coolify host, Traefik's default
      // 60s readTimeout (which bounds reading the whole request INCLUDING the
      // body) turns a slow large upload into a 504 with an HTML body, and the
      // panel showed a bare "Request failed" that named neither the status nor
      // the reason. Name both.
      const contentType = res.headers.get('content-type') || '';
      const statusText = res.statusText ? ` ${res.statusText}` : '';
      const proxyHint = contentType.includes('application/json')
        ? ''
        : ' — answered by a proxy/edge, not the API (large upload or a timeout?)';
      throw new ApiError(
        json?.code || 'GEN_001',
        res.status,
        json?.message || `Request failed (HTTP ${res.status}${statusText})${proxyHint}`,
        json?.refunded,
        details
      );
    }
    // Uniform response contract validation (docs/19 §21): only ever parse
    // what we declared. A shape drift between API and client used to surface
    // as a late `.toFixed is not a function` deep inside a component.
    if (options.schema) {
      const parsed = options.schema.safeParse(json.data);
      if (!parsed.success) {
        throw new ApiError(
          'GEN_DTO',
          502,
          `Unexpected response from ${method} ${path}`
        );
      }
      return parsed.data as T;
    }
    return json.data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Timeout: caller decides via betStatus recovery (docs/19 §7 4c)
    throw new ApiError('GEN_TIMEOUT', 408, 'Connection timeout');
  } finally {
    clearTimeout(timeout);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
export const http = {
  get: <T>(p: string, o?: RequestOptions) => api<T>(p, { ...o, method: 'GET' }),
  post: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    api<T>(p, { ...o, method: 'POST', body }),
  patch: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    api<T>(p, { ...o, method: 'PATCH', body }),
  put: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    api<T>(p, { ...o, method: 'PUT', body }),
  del: <T>(p: string, o?: RequestOptions) => api<T>(p, { ...o, method: 'DELETE' }),
  delete: <T>(p: string, o?: RequestOptions) => api<T>(p, { ...o, method: 'DELETE' }),
};

/** Timeout recovery: did the round exist for this seed+nonce? (docs/19 §7 4c) */
export interface RecoveredBetRound {
  roundId: string;
  result: SettledRoundResult;
  payoutAmount: number;
  payoutMultiplier: number;
  mappedOutcome: Record<string, unknown> | null;
  nonce: number;
  seedHash: string;
  newBalance: {
    real: number | string;
    bonus: number | string;
    gifted: number | string;
    locked: number | string;
  };
}

/** M-08: recover by the SAME durable idempotency key that accompanied the
 *  bet. Querying by (clientSeed, nonce) raced other tabs/games — whichever
 *  round consumed that nonce first was returned, which might not be OUR bet. */
export async function betStatus(
  gameSlug: string,
  opts: { requestId?: string; clientSeed?: string; nonce?: number }
) {
  const params = new URLSearchParams({ game: gameSlug });
  if (opts.requestId) params.set('requestId', opts.requestId);
  if (opts.clientSeed) params.set('clientSeed', opts.clientSeed);
  if (opts.nonce !== undefined) params.set('nonce', String(opts.nonce));
  const out = await http.get<{ round: RecoveredBetRound } | null>(
    `/games/bet-status?${params.toString()}`,
    { schema: betStatusDto }
  );
  return out;
}

/**
 * Upload a platform archive as a series of small requests, then hand back the
 * path the API will restore from.
 *
 * Why not `uploadWithProgress` (one request): the archive travels through
 * Traefik on a Dokploy host and then through this app's own rewrite proxy, and
 * Traefik's default read timeout is a deadline for the whole request *including
 * the body*. A multi-minute upload therefore got cut at ~99% with
 * "Upload failed (HTTP 408)" and nothing restored. Chunks each finish in
 * seconds, and a failed chunk is retried rather than restarting the file.
 *
 * Progress goes 0→99% here; the caller then polls the restore job for the rest.
 */
export async function uploadArchiveInChunks(
  file: File,
  opts: { onProgress?: (percent: number, loaded: number, total: number) => void } = {}
): Promise<{ tempPath: string; bytes: number; chunkSize: number }> {
  // Ask the server for its chunk size and ceiling before sending anything, so an
  // oversized file is refused in a second rather than after an hour of upload.
  const init = await api<{ uploadId: string; chunkSize: number; received: number; ceiling: number }>(
    '/panel/backup/upload/init',
    { method: 'POST', body: { size: file.size }, timeoutMs: 30000 }
  );
  const uploadId = init.uploadId;

  const sendChunk: ChunkSender = async ({ offset, blob }) => {
    const res = await fetch(`${BASE}/panel/backup/upload/chunk?uploadId=${uploadId}&offset=${offset}`, {
      method: 'POST',
      body: blob,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-CSRF-Token': readCsrf(),
        'X-Request-ID': uuid(),
      },
    });
    const text = await res.text();
    let parsed: { success?: boolean; data?: unknown; code?: string; message?: string } | null = null;
    try {
      parsed = JSON.parse(text) as { success?: boolean; data?: unknown; code?: string; message?: string };
    } catch {
      parsed = null; // a proxy/edge answered instead of the API (HTML, empty…)
    }
    if (!res.ok || parsed?.success === false) {
      throw new ApiError(
        parsed?.code ?? `HTTP_${res.status}`,
        res.status,
        parsed?.message ??
          (res.status === 408
            ? 'The connection timed out while sending this part of the file — retrying.'
            : `This part of the upload was refused (HTTP ${res.status}).`)
      );
    }
  };

  await uploadInChunks(file, sendChunk, {
    chunkSize: init.chunkSize,
    onProgress: opts.onProgress,
  });

  const done = await api<{ tempPath: string; bytes: number }>('/panel/backup/upload/finish', {
    method: 'POST',
    body: { uploadId },
    timeoutMs: 60000,
  });
  return { ...done, chunkSize: init.chunkSize };
}

export interface RestoreJobView {
  id: string;
  state: 'running' | 'done' | 'error';
  stage: string;
  label: string;
  percent: number;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

/**
 * Watch a restore job until it ends. The API runs the restore in the background
 * and answers status requests immediately, so no proxy can cut the operation —
 * and the outcome is visible even if the restore signs the admin out (which it
 * does: the backup's AdminUser rows replace the current ones).
 */
export async function pollRestoreJob(
  jobId: string,
  jobToken: string,
  opts: {
    onUpdate?: (job: RestoreJobView) => void;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<RestoreJobView> {
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60 * 1000);
  const wait = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: RestoreJobView | null = null;

  for (;;) {
    const job = await api<RestoreJobView>(
      `/panel/backup/restore/status?jobId=${jobId}&jobToken=${jobToken}`,
      { timeoutMs: 20000, skipAuth: true }
    );
    last = job;
    opts.onUpdate?.(job);
    if (job.state !== 'running') return job;
    if (Date.now() > deadline) return job;
    await wait(interval);
  }
}

/**
 * POST a File with real upload progress.
 *
 * `fetch` still cannot report request-body progress, so a multi-hundred-megabyte
 * platform restore would be a frozen button with no idea whether it was working.
 * XMLHttpRequest can. This keeps the rest of the contract identical to `api()`:
 * cookies, CSRF header, the same response envelope, and an ApiError on failure —
 * including AUTH_010, so `useStepUp().run(...)` can prompt and replay.
 */
export function uploadWithProgress<T>(
  path: string,
  file: File,
  opts: {
    contentType?: string;
    timeoutMs?: number;
    onProgress?: (percent: number, loaded: number, total: number) => void;
  } = {}
): Promise<T> {
  const {
    contentType = file.type || 'application/octet-stream',
    // Restoring a big archive can take a while; the API allows 30 minutes.
    timeoutMs = 30 * 60 * 1000,
    onProgress,
  } = opts;

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`, true);
    xhr.withCredentials = true;
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('X-CSRF-Token', readCsrf());
    xhr.setRequestHeader('X-Request-ID', uuid());

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)), e.loaded, e.total);
      };
      xhr.upload.onload = () => onProgress(99, file.size, file.size);
    }

    let parsed: unknown = null;
    xhr.onload = () => {
      try {
        parsed = JSON.parse(xhr.responseText) as unknown;
      } catch {
        parsed = null;
      }
      const envelope = parsed as
        | { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } }
        | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((envelope?.data ?? envelope) as T);
        return;
      }
      const err = envelope?.error;
      reject(
        new ApiError(
          err?.code ?? `HTTP_${xhr.status}`,
          xhr.status,
          err?.message ?? `Upload failed (HTTP ${xhr.status})`
        )
      );
    };
    xhr.onerror = () =>
      reject(new ApiError('GEN_NETWORK', 0, 'The upload was interrupted — check your connection.'));
    xhr.ontimeout = () =>
      reject(new ApiError('GEN_TIMEOUT', 408, 'The upload took too long and was stopped.'));
    xhr.onabort = () => reject(new ApiError('GEN_ABORTED', 0, 'Upload cancelled.'));

    xhr.send(file);
  });
}

/** Presigned upload (v7 §5) — direct to MinIO, no large files through the API. */
export async function uploadProof(file: File): Promise<string> {
  // Validate client-side first so the user gets an instant, specific message
  // instead of a generic failure after two silent round-trips.
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED.includes(file.type)) {
    throw new ApiError('FIN_006', 422, 'Please choose a JPG, PNG or WebP image.');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new ApiError(
      'FIN_007',
      422,
      `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 5MB.`
    );
  }

  // PATH A: presigned PUT straight to MinIO. Cheapest path — but it depends on
  // S3_PUBLIC_ENDPOINT being browser-reachable. When that breaks (2026-08-21
  // correction #8) we fall through to PATH B automatically instead of dying.
  let directErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { presignedUrl, objectKey } = await http.post<{
        presignedUrl: string;
        objectKey: string;
      }>('/deposits/upload-url', {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });

      const res = await fetch(presignedUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ApiError(
          'FIN_006',
          422,
          `Storage rejected the upload (${res.status}). ${detail.slice(0, 120)}`.trim()
        );
      }
      return objectKey;
    } catch (e) {
      directErr = e as Error;

      // A CSRF failure never fixes itself on retry — the cookie is missing.
      // /auth/me re-issues it, so refresh the session once and try again.
      if (e instanceof ApiError && e.code === 'CSRF_INVALID' && attempt === 0) {
        await healCsrf('/deposits/upload-url').catch(() => {});
        continue;
      }
      break; // direct path is dead — go to the relay
    }
  }

  // PATH B: relay through the API (browser → API → MinIO with the internal
  // client). No dependency on S3_PUBLIC_ENDPOINT at all; the browser only
  // needs the API domain it already reached to log in.
  try {
    return await uploadProofViaRelay(file);
  } catch (relayErr) {
    // Surface BOTH failures: the relay reason usually explains the fix
    // (auth? network? file?), the direct reason explains the config bug.
    const d = directErr?.message ?? 'direct-to-storage failed';
    const r = (relayErr as Error).message;
    throw new ApiError(
      'FIN_UPLOAD',
      502,
      `Screenshot upload failed. Direct: ${d.slice(0, 90)}. Relay: ${r.slice(0, 90)}`
    );
  }
}

/** Multipart relay upload: POST /deposits/upload (server streams to MinIO). */
async function uploadProofViaRelay(file: File): Promise<string> {
  const doSend = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      'X-CSRF-Token': readCsrf(),
    };
    const token = useAuthStore.getState().accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
    const form = new FormData();
    form.append('file', file, file.name);
    // NOTE: do NOT set Content-Type — the browser must add the multipart boundary.
    return fetch(`${BASE}/deposits/upload`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: form,
    });
  };
  let res = await doSend();
  if (res.status === 403) {
    const peeked = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (peeked?.code === 'CSRF_INVALID') {
      await healCsrf('/deposits/upload').catch(() => {});
      res = await doSend();
    }
  }
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doSend();
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { objectKey?: string };
    message?: string;
    code?: string;
  } | null;
  if (res.ok && json?.success && json.data?.objectKey) return json.data.objectKey;
  throw new ApiError(
    json?.code || 'FIN_006',
    res.status,
    json?.message || `Relay upload failed (${res.status})`
  );
}

/** D-079/M-09: UUID helper with fallback — crypto.randomUUID is missing in
 *  non-secure contexts / older browsers. The API validates `requestId` with
 *  z.string().uuid(), so the fallback must be a REAL RFC-4122 v4 UUID — the
 *  old `id-…` string was rejected, which made betting impossible in exactly
 *  the browsers the comment promised to support. */
export function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  // RFC-4122 v4 over whatever CSPRNG is available (getRandomValues exists
  // everywhere Math.random-quality ids were previously used).
  const buf = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  buf[6] = (buf[6]! & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
