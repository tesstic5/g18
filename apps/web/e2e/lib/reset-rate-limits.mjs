// e2e/lib/reset-rate-limits.mjs — sandbox-only test helper.
// Resets the API's Redis-backed rate-limit counters (rl:*) for loopback
// subjects so a full probe sweep can run back-to-back without tripping the
// production-intended limits (signup 10/h, login 20/15m, ws 5/min, ...).
// NEVER pointed at production — guard-rails refuse unless the API URL is a
// loopback host. Zero product-code impact; it only deletes `rl:` keys.
//
// Usage:
//   node e2e/lib/reset-rate-limits.mjs            # reset all rl:* counters
//   import { resetRateLimits } from './lib/reset-rate-limits.mjs';
import net from 'node:net';

const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || 56379);
const API = process.env.API || 'http://localhost:4000';

function redisCmd(...args) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(REDIS_PORT, '127.0.0.1', () => {
      c.write(encode(...args));
    });
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('error', reject);
    setTimeout(() => {
      c.end();
      resolve(parse(buf));
    }, 400);
  });
}
const encode = (...args) =>
  `*${args.length}\r\n` +
  args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('');
// Minimal RESP reader — good enough for arrays of bulk strings / integers.
function parse(buf) {
  const items = [];
  for (const m of buf.matchAll(/\$\d+\r\n([^\r]+)/g)) items.push(m[1]);
  const n = buf.match(/^:(\d+)/);
  return items.length ? items : n ? Number(n[1]) : buf.trim();
}

export async function resetRateLimits(subjects = ['127.0.0.1']) {
  const url = new URL(API);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname))
    throw new Error(`Refusing to clear rate limits against non-loopback API (${API})`);
  const keys = (await redisCmd('KEYS', 'casino:rl:*')).filter((k) =>
    subjects.some((s) => k.endsWith(`:${s}`))
  );
  if (!keys.length) return 0;
  const del = await redisCmd('DEL', ...keys);
  return del;
}

// direct run
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = await resetRateLimits();
  console.log(`rate-limit counters cleared: ${n}`);
}
