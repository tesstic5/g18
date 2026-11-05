// apps/api/src/server.ts — Fastify bootstrap (docs/20 §1 canonical)
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createArchiveUploadParser } from './lib/archiveUploadParser';

import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { Server } from 'socket.io';

import { prisma } from './db/prisma';
import { redis, logRedisIssue } from './db/redis';
import { AppError, makeErrorHandler } from './lib/core';
import { isOriginAllowed } from './lib/origins';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { getSetting } from './services/settings';
import { initializeSocketServer } from './socket/SocketServer';
import { ensureBuckets } from './db/minio';
import { csrfMiddleware } from './middleware';
import { reportEnvironment } from './lib/env-check';
import { authRoutes } from './routes/auth';
import { walletRoutes } from './routes/wallet';
import { gameRoutes } from './routes/games';
import { provablyFairRoutes } from './routes/provably-fair';
import { payfastRoutes, payfastAdminRoutes, payfastMaintenanceExempt } from './routes/payfast';
import { depositRoutes } from './routes/deposits';
import { withdrawalRoutes } from './routes/withdrawals';
import { userRoutes } from './routes/user';
import { bonusRoutes } from './routes/bonuses';
import { referralRoutes } from './routes/referral';
import { leaderboardRoutes } from './routes/leaderboard';
import { supportRoutes } from './routes/support';
import { notificationRoutes } from './routes/notifications';
import { giftRoutes } from './routes/gifts';
import { legalRoutes } from './routes/legal';
import { reportRoutes } from './routes/reports';
import { clientErrorRoutes } from './routes/client-errors';
import { panelRoutes } from './routes/panel';
import { panelGameRoutes } from './routes/panel-games';
import { panelFaqRoutes } from './routes/panel-faqs';
import { panelRecoveryRoutes } from './routes/panel-recovery';
import { panelSecurityRoutes } from './routes/panel-security';
import { panelReferralRoutes } from './routes/panel-referral';
import { referralPanelRoutes } from './routes/referralPanel';
import recoveryRoutes from './routes/recovery';

export async function buildServer() {
  // Never trust arbitrary X-Forwarded-For from a directly exposed API port.
  // Operators list only their reverse-proxy CIDRs/addresses.
  const trustProxy = (process.env.TRUST_PROXY ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      serializers: { req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url?.includes('/payfast/') ? '/api/v1/payfast/[redacted]' : req.url }) },
      ...(process.env.LOG_PRETTY === 'true'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: trustProxy.length ? trustProxy : false,
    bodyLimit: 10 * 1024 * 1024,
    // Node's requestTimeout bounds how long the CLIENT may take to SEND the
    // request (headers + body) — it does not cap how long a handler may run.
    // The 30s default suits JSON APIs but aborts a large backup upload over a
    // slow link (a 256 MiB bundle needs ~3.5 min at 10 Mbps). Override with
    // REQUEST_TIMEOUT_MS; keep it >= 60000 to stay clear of the Socket.IO
    // pingTimeout constraint documented below.
    requestTimeout: Number(process.env.REQUEST_TIMEOUT_MS) || 30000,
  });

  // ── PLUGINS (order matters — docs/20 §1) ──────────────────────────────
  // Treat an EMPTY json body as {}. Several endpoints are plain "do this now"
  // actions with no payload (daily check-in, mark-all-read, cashout), and the
  // web client posts them with Content-Type: application/json and no body.
  // Fastify's default parser rejects that combination outright
  // (FST_ERR_CTP_EMPTY_JSON_BODY -> 400), which made the daily bonus button
  // fail for real users.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw === '') return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  // ── BACKUP ARCHIVE UPLOADS ────────────────────────────────────────────
  // A .tar.gz platform backup is streamed straight to a temp file. The default
  // 'buffer' parser would hold the whole archive — gigabytes, including every
  // uploaded image — in RAM. See lib/archiveUploadParser.ts for why the size
  // ceiling is enforced there rather than by `bodyLimit`.
  fastify.addContentTypeParser(
    ['application/gzip', 'application/x-gzip'],
    createArchiveUploadParser()
  );
  // Chunked restore uploads (lib/chunkedUpload.ts): each request is a few MB of
  // the archive, streamed straight onto the partial file by the route. Handing
  // back the live stream (instead of buffering) keeps memory flat, and the route
  // enforces its own byte ceiling because a custom parser is never limited by
  // Fastify's bodyLimit.
  fastify.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload)
  );

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Dev/preview: reflect any origin (sandbox preview hosts change per session).
      // Production (D-104): ROBUST allowlist — compare NORMALIZED origins so
      // trailing slashes, http↔https and www-vs-bare can never silently break
      // login/refresh (the previous exact-match rejected real browsers →
      // "Not allowed by CORS" → 500 on every auth call).
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      if (isOriginAllowed(origin, process.env.FRONTEND_URL)) return cb(null, true);
      // D-104: a denied origin is a 403 WITH a clear message — never a masked
      // 500 "An unexpected error occurred" (the error handler keeps AppError
      // status codes; the client maps CORS_DENIED to actionable text).
      cb(
        new AppError('CORS_DENIED', 403, 'Origin not allowed by server configuration'),
        false
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Request-ID',
      'X-Demo-Mode',
      'X-Demo-Session',
    ],
    exposedHeaders: ['X-Request-ID', 'X-CSRF-Token'],
  });
  await fastify.register(cookie, { secret: process.env.COOKIE_SECRET! });
  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  await fastify.register(rateLimit, {
    global: false,
    redis,
    keyGenerator: (r) => (r.user?.id as string) || r.ip,
  });

  // ── REQUEST ID (docs/20 §1) ───────────────────────────────────────────
  fastify.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || crypto.randomUUID();
    request.requestId = requestId;
    reply.header('X-Request-ID', requestId);
  });

  // ── MAINTENANCE MODE (docs/19 §24 feature flags) ─────────────────────
  // 503 GEN_MAINTENANCE on all API traffic except /health and the admin panel
  // (admins must be able to log in and turn it off). Setting is Redis-cached 30s.
  fastify.addHook('onRequest', async (request) => {
    const url = request.url;
    if (!url.startsWith('/api/v1')) return;
    if (payfastMaintenanceExempt(url)) return;
    if (url.startsWith('/api/v1/panel/')) return; // admin must stay reachable
    if (url.startsWith('/api/v1/auth/login')) return; // player login needed to see the notice
    // Recovery intake stays open: a locked-out player has no other way in, and
    // closing it during maintenance would leave them with no recourse.
    if (url.startsWith('/api/v1/recovery')) return;
    if (await getSetting<boolean>('maintenance_mode')) {
      throw new AppError(
        ERROR_CODES.GEN_MAINTENANCE,
        503,
        'Platform is under maintenance. Please check back soon.'
      );
    }
  });

  // ── CSRF (docs/14) — double-submit on state-changing panel/user routes, exempting auth
  fastify.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (url.startsWith('/api/v1/auth/') || url.startsWith('/api/v1/panel/auth/'))
      return;
    if (
      url.startsWith('/api/v1/panel/') ||
      url.startsWith('/api/v1/deposits') ||
      url.startsWith('/api/v1/payfast/checkout') ||
      url.startsWith('/api/v1/withdrawals')
    ) {
      await csrfMiddleware(request, reply);
    }
  });

  // ── MONITORING COUNTERS ───────────────────────────────────────────────
  // Cheap in-process counters, exposed on /metrics. Monitoring must never be
  // a reason a request fails, so every call here is fire-and-forget.
  fastify.addHook('onResponse', async (request, reply) => {
    void import('./services/monitoring')
      .then((m) => {
        m.bumpCounter('requests');
        // NOTE: status-code error counting moved to the error handler
        // (lib/core makeErrorHandler), which is the only place the
        // machine-readable code exists. Passing a literal 'http' here made
        // every code-based classification impossible.
        if (request.url.startsWith('/api/v1/auth/login')) {
          if (reply.statusCode === 200) m.bumpCounter('logins');
        }
        if (request.url.startsWith('/api/v1/withdrawals/create') && reply.statusCode === 200)
          m.bumpCounter('withdrawalsCreated');
      })
      .catch(() => undefined);
  });

  // ── METRICS ───────────────────────────────────────────────────────────
  // Unauthenticated by design (Prometheus scrapes cannot hold a panel cookie)
  // but REQUIRES a bearer token: without METRICS_TOKEN set the endpoint does
  // not exist, so a deployment that never opts in exposes nothing new.
  fastify.get('/metrics', async (request, reply) => {
    const expected = process.env.METRICS_TOKEN || '';
    if (!expected) return reply.status(404).send({ error: 'not found' });
    const header = String(request.headers.authorization ?? '');
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const { tokenMatches, renderMetrics } = await import('./services/monitoring');
    if (!tokenMatches(provided, expected)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const [pendingSecond, alertsOpen] = await Promise.all([
      prisma.withdrawal.count({
        where: { dualControlRequired: true, firstApprovedBy: { not: null }, status: 'PENDING' },
      }),
      prisma.securityAlert.count({ where: { status: 'open' } }),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(
      renderMetrics({
        casino_dual_control_pending: pendingSecond,
        casino_security_alerts_open: alertsOpen,
      })
    );
  });

  // ── GLOBAL ERROR HANDLER (docs/19 §12 envelope) ───────────────────────
  fastify.setErrorHandler(makeErrorHandler(fastify.log.error.bind(fastify.log)));

  // ── HEALTH (docs/20 §17) ──────────────────────────────────────────────
  fastify.get('/health', async () => {
    let dbOk = false;
    let redisOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      /* degraded */
    }
    try {
      await redis.ping();
      redisOk = true;
    } catch {
      /* degraded */
    }
    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: { database: dbOk ? 'ok' : 'error', redis: redisOk ? 'ok' : 'error' },
    };
  });
  fastify.get('/health/ready', async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ready: true };
    } catch {
      return reply.status(503).send({ ready: false });
    }
  });

  // ── ROUTES ────────────────────────────────────────────────────────────
  await fastify.register(authRoutes, { prefix: '/api/v1/auth' });
  await fastify.register(walletRoutes, { prefix: '/api/v1/wallet' });
  await fastify.register(gameRoutes, { prefix: '/api/v1/games' });
  await fastify.register(provablyFairRoutes, { prefix: '/api/v1/provably-fair' });
  await fastify.register(payfastAdminRoutes, { prefix: '/api/v1/panel/payfast' });
  await fastify.register(payfastRoutes, { prefix: '/api/v1/payfast' });
  await fastify.register(depositRoutes, { prefix: '/api/v1/deposits' });
  await fastify.register(withdrawalRoutes, { prefix: '/api/v1/withdrawals' });
  await fastify.register(userRoutes, { prefix: '/api/v1/user' });
  await fastify.register(bonusRoutes, { prefix: '/api/v1/bonuses' });
  await fastify.register(referralRoutes, { prefix: '/api/v1/referral' });
  await fastify.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
  await fastify.register(supportRoutes, { prefix: '/api/v1/support' });
  // Public (unauthenticated) lockout surface — see routes/recovery.ts.
  await fastify.register(recoveryRoutes, { prefix: '/api/v1/recovery' });
  await fastify.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await fastify.register(giftRoutes, { prefix: '/api/v1/gifts' });
  await fastify.register(legalRoutes, { prefix: '/api/v1/legal' });
  await fastify.register(reportRoutes, { prefix: '/api/v1/panel/reports' });
  await fastify.register(clientErrorRoutes, { prefix: '/api/v1/errors' });
  await fastify.register(panelRoutes, { prefix: '/api/v1/panel' });
  await fastify.register(panelGameRoutes, { prefix: '/api/v1/panel' });
  await fastify.register(panelFaqRoutes, { prefix: '/api/v1/panel' });
  await fastify.register(panelRecoveryRoutes, { prefix: '/api/v1/panel' });
  // Step-up re-auth, monitoring/alerts, parked dual-control credits, key rotation.
  await fastify.register(panelSecurityRoutes, { prefix: '/api/v1/panel' });
  // Referral agent management (super-admin) + the agent console API.
  await fastify.register(panelReferralRoutes, { prefix: '/api/v1/panel' });
  await fastify.register(referralPanelRoutes, { prefix: '/api/v1/referral-panel' });

  return fastify;
}

// ── GRACEFUL SHUTDOWN + SOCKET.IO (docs/20 §1) ───────────────────────────
async function start() {
  // Report the whole environment ONCE, up front. Compose no longer aborts on a
  // single missing variable, so this is where misconfiguration surfaces — with
  // every problem listed at once instead of one per redeploy.
  if (!reportEnvironment()) process.exit(1);

  const fastify = await buildServer();
  // Attach Socket.IO to Fastify's own http server (fastify.server) — never wrap it
  // in a fresh createServer: Fastify's requestTimeout must stay >= Socket.IO's
  // pingTimeout (60s) or Node throws ERR_OUT_OF_RANGE.
  const io = new Server(fastify.server, {
    cors: {
      // Dev/preview: reflect any origin (sandbox preview hosts rotate per session).
      // Production: the SAME allowlist as the REST API (lib/origins.ts) — loopback
      // on any port plus FRONTEND_URL. This used to be a bare string, i.e. an
      // EXACT match on FRONTEND_URL, so serving the app from a different address
      // (local run on another port, renamed host) killed the live feed with a
      // CORS error even though REST worked.
      origin:
        process.env.NODE_ENV === 'production'
          ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
              cb(null, isOriginAllowed(origin, process.env.FRONTEND_URL))
          : true,
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    // D-096 FIX: engine.io 6.6.9's check() is a strict prefix match — it only
    // handles '/socket.io/' (with trailing slash; the socket.io-client always
    // uses it). When the browser goes through the web app's own proxy (Next
    // rewrite / nginx) the slash can be stripped → 404 → dead socket. The
    // slash is re-added on the WEB side (next.config.ts exact rewrite); here
    // we additionally normalize the no-slash form so direct hits also work.
  });
  // H-6: multi-instance fan-out.
  //
  // Socket.IO keeps its room membership in the memory of ONE process. With two
  // or more API instances behind a load balancer, `io.to('user:X').emit(...)`
  // only reaches player X if they happen to be connected to the instance that
  // ran the emit. Every cross-instance message — balance updates, personal
  // WinGo/crash results, admin feed — is silently dropped for everyone else.
  //
  // The Redis adapter publishes emits over pub/sub so all instances deliver
  // them. It is skipped when REDIS_URL is unset (local dev / tests) and never
  // takes the API down if Redis is briefly unavailable: single-instance
  // behaviour is still correct without it.
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      // The main client runs with `enableOfflineQueue: false` on purpose — a bet
      // must fail fast rather than queue behind a dead Redis. That setting is
      // wrong for pub/sub: the adapter issues PSUBSCRIBE the moment it is
      // constructed, before the socket has finished connecting, and the command
      // is rejected outright with "Stream isn't writeable". (Observed at boot.)
      // So the adapter gets its own pair of clients that are allowed to queue.
      const { default: IORedis } = await import('ioredis');
      const adapterOpts = {
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'casino:',
        enableOfflineQueue: true,
        maxRetriesPerRequest: null as null,
        retryStrategy: (times: number) => Math.min(times * 200, 2000),
      };
      const url = process.env.REDIS_URL as string;
      const pubClient = new IORedis(url, adapterOpts);
      const subClient = new IORedis(url, adapterOpts);
      pubClient.on('error', (e: Error) => logRedisIssue('socket-adapter-pub', e));
      subClient.on('error', (e: Error) => logRedisIssue('socket-adapter-sub', e));
      io.adapter(createAdapter(pubClient, subClient));
      fastify.log.info('Socket.IO Redis adapter attached (multi-instance safe)');
    } catch (e) {
      fastify.log.warn(
        `Socket.IO Redis adapter unavailable (${(e as Error).message}) — running single-instance. ` +
          'Do NOT scale the API beyond one replica until this is resolved.'
      );
    }
  }

  // D-096: engine.io 6.6.9 matches '/socket.io/' EXACTLY (strict prefix on the
  // trailing slash). Any client that hits '/socket.io' without the slash (e.g.
  // a direct connection, or a proxy that stripped it) gets a 301 to the
  // canonical form instead of a Fastify 404. (The web rewrite already re-adds
  // the slash for browser traffic — this covers direct API hits.)
  fastify.get('/socket.io', (request, reply) => {
    const q = request.url.split('?')[1];
    reply.redirect(`/socket.io/${q ? `?${q}` : ''}`, 301); // Fastify 5: redirect(url, code)
  });

  initializeSocketServer(io);
  // expose io for services (big-win broadcasts etc.)
  (globalThis as { __io?: Server }).__io = io;
  // ensure MinIO buckets exist (non-fatal — deposit flow stays usable)
  await ensureBuckets();

  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}, starting graceful shutdown`);
    await fastify.close();
    io.close();
    await prisma.$disconnect();
    await redis.quit();
    fastify.log.info('Graceful shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    fastify.log.error({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    fastify.log.error({ reason }, 'Unhandled rejection');
  });

  await fastify.listen({
    port: parseInt(process.env.PORT || '4000'),
    host: process.env.HOST || '0.0.0.0',
  });
  fastify.log.info('API + Socket.IO listening on :4000');
}

if (process.env.NODE_ENV !== 'test')
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
