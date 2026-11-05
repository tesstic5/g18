// apps/api/src/lib/core.ts — standardized response envelope + errors (docs/19 §12)
import crypto from 'crypto';
import { ERROR_CODES } from '@casino/shared/constants/errors';

export class AppError extends Error {
  constructor(
    public readonly code: keyof typeof ERROR_CODES | string,
    public readonly statusCode: number,
    message?: string,
    public readonly details?: unknown,
    public readonly refunded?: boolean
  ) {
    super(message || code);
    this.name = 'AppError';
  }
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiErrorBody {
  success: false;
  code: string; // from ERROR_CODES
  message: string; // user-friendly, safe to display
  details?: unknown; // never sensitive
  requestId: string; // for support reference
  refunded?: boolean; // bet errors only
}

export const ok = <T>(data: T, requestId: string): ApiSuccess<T> => ({
  success: true,
  data,
  requestId,
});

export const err = (e: unknown, requestId: string): ApiErrorBody => {
  if (e instanceof AppError) {
    return {
      success: false,
      code: e.code,
      message: e.message || e.code,
      details: e.details,
      requestId,
      refunded: e.refunded,
    };
  }
  // D-103: DB/connection failures are COMMON (deploys restart Postgres, pool
  // exhaustion, brief network blips between api and postgres containers) and
  // must NOT be masked as a generic 500 — the operator/user needs to know the
  // server is temporarily unavailable, not that "an unexpected error occurred".
  if (isDbUnavailable(e)) {
    return {
      success: false,
      code: 'SVC_503',
      message:
        'Service is temporarily unavailable — the database is starting up or unreachable. Please try again in a moment.',
      requestId,
    };
  }
  // Prisma P2025 = "record not found" (findUniqueOrThrow / update on a
  // missing row). That is a client error, not a server fault — 404 with a
  // safe message instead of a masked 500.
  if ((e as { code?: string })?.code === 'P2025') {
    return {
      success: false,
      code: ERROR_CODES.GEN_NOT_FOUND,
      message: 'The requested record was not found',
      requestId,
    };
  }
  // Operational errors (4xx) can expose message; internal (5xx) never do.
  const status = (e as { statusCode?: number })?.statusCode;
  const operational = !!status && status < 500;
  return {
    success: false,
    code: (e as { code?: string })?.code || ERROR_CODES.GEN_SERVER_ERROR,
    message: operational ? (e as Error).message : 'An unexpected error occurred',
    requestId,
  };
};

/** Prisma + network connection failures (DB down, pool timeout, restart). */
function isDbUnavailable(e: unknown): boolean {
  const code = String((e as { code?: string })?.code || '');
  const msg = (e as Error)?.message || '';
  return (
    /^P10\d\d/.test(code) || // P1001 can't reach, P1008 timeout, P1017 closed…
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    /connection.*(refused|closed|terminated|timed out|reset)/i.test(msg) ||
    /database.*(unavailable|not reachable|does not exist|connection)/i.test(msg) ||
    /prisma.*(can't reach|timed out|closed)/i.test(msg)
  );
}

// requestId hook — attach to every request/reply (docs/20 §1)
export function requestIdFrom(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = req.headers['x-request-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw || crypto.randomUUID();
}

// Global error handler for Fastify (docs/20 §1)
import type { FastifyReply, FastifyRequest } from 'fastify';
export function makeErrorHandler(log: (obj: unknown, msg?: string) => void) {
  return async (
    error: Error & { statusCode?: number; code?: string },
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const requestId =
      (request as unknown as { requestId?: string }).requestId || crypto.randomUUID();
    log(
      { err: request.url.includes('/payfast/') ? { name: error.name, code: error.code } : error, requestId, url: /\/payfast\//.test(request.url) ? '/api/v1/payfast/[redacted]' : request.url, method: request.method },
      'request error'
    );
    const body = err(error, requestId);
    // Zod validation failures → 400 GEN_001 instead of a 500 (docs/19 §12)
    if (error && (error as { name?: string }).name === 'ZodError') {
      return reply.status(400).send({
        success: false,
        code: ERROR_CODES.GEN_VALIDATION_ERROR,
        message: 'Invalid request payload',
        details: (error as { issues?: unknown }).issues,
        requestId,
      });
    }
    // AppError carries an explicit status (incl. 503 GEN_005 maintenance) — keep it;
    // unknown errors without a status are masked to 500. D-103: DB/connection
    // failures are reported as 503 (temporarily unavailable), not 500.
    const status =
      error instanceof AppError
        ? error.statusCode
        : error.code === 'P2025'
          ? 404
          : error.statusCode && error.statusCode < 500
            ? error.statusCode
            : isDbUnavailable(error)
              ? 503
              : 500;
    // Monitoring: the error handler is the only place the machine-readable
    // code exists, so this is where 5xx bursts and unexpected 4xx are counted.
    // Fire-and-forget — monitoring must never affect a response.
    void import('../services/monitoring')
      .then((m) => m.recordError(status, String(body.code)))
      .catch(() => undefined);
    return reply.status(status).send(body);
  };
}
