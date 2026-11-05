// apps/api/src/db/redis.ts — ioredis singleton + key helpers (docs/19 §13)
// D-081: FAIL-OPEN config. Default ioredis QUEUES commands while disconnected
// (enableOfflineQueue: true, maxRetriesPerRequest: 2 → commands can hang for
// many seconds or forever), which turned a Redis outage into timeouts/500s on
// login/signup/bets. With the queue disabled and 1 retry, commands REJECT
// immediately when Redis is down, and every caller's try/catch fail-open
// (auth, rate-limit, settings, stats, locks) kicks in right away.
import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'casino:',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

// ioredis emits `error` events independently of rejected commands. Without a
// listener Node treats them as unhandled; Vitest reported passing suites as
// failed and production could emit noisy uncaught events during Redis restarts.
redis.on('error', (error) => {
  if (process.env.NODE_ENV !== 'test' && redis.status === 'ready') {
    console.error('[redis] connection error:', error.message);
  }
});

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

/**
 * True while the client has not finished its FIRST connection.
 *
 * ioredis connects asynchronously, so anything touching Redis in the first
 * moments after boot (the six round managers each load their game config)
 * rejects with "Stream isn't writeable and enableOfflineQueue options is
 * false". That is expected and self-heals within a second — it should not be
 * logged as an error, which made every deploy look broken.
 */
export function redisWarmingUp(): boolean {
  return redis.status !== 'ready';
}

/**
 * Log a Redis failure at the right level: silent while still connecting,
 * a real error once the client has been ready at least once.
 */
export function logRedisIssue(scope: string, e: unknown): void {
  if (redisWarmingUp()) return; // boot-time race — not an error
  console.error(`[${scope}] redis unavailable:`, (e as Error).message);
}

// Key builders (docs/19 §13 exact namespaces)
export const keys = {
  session: (userId: string) => `session:${userId}`,
  refresh: (family: string) => `refresh_token:${family}`,
  family: (family: string) => `token_family:${family}`,
  rl: (name: string, subject: string) => `rl:${name}:${subject}`,
  gameStats: (slug: string) => `game:stats:${slug}`,
  crashRound: (slug: string) => `game:crash:${slug}:current`, // per-slug (aviator | crash-x)
  wingoRound: (dur: '30s' | '60s' | '180s' | '300s') => `game:wingo:${dur}:current`,
  // Per USER, not per game — see the note at the one-shot call site in
  // OutcomeEngine.processOutcome for why that is the correct scope.
  betLock: (userId: string) => `lock:bet:${userId}`,
  walletLock: (userId: string) => `lock:wallet:${userId}`,
  lb: (period: 'daily' | 'weekly' | 'all_time', key: string) =>
    period === 'all_time' ? 'lb:all_time' : `lb:${period}:${key}`,
  bigWins: () => 'feed:lobby:bigwins',
  gameFeed: (slug: string) => `feed:game:${slug}`,
  configCache: (slug: string) => `cache:game_config:${slug}`,
  settingsCache: () => 'cache:settings',
  dailyLoss: (userId: string, date: string) => `resp:daily_loss:${userId}:${date}`,
  dailyDeposit: (userId: string, date: string) =>
    `resp:daily_deposit:${userId}:${date}`,
  unread: (userId: string) => `notif:unread:${userId}`,
};
