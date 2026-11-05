// WINGO DRAW-TIME FLAP PROBE — cuts Redis connectivity for 9s starting ~6s
// before a 30s wingo draw, i.e. exactly across the moment the manager reads
// the round from Redis, flips it to DRAWING and reveals the result.
// OLD code: that single failure killed the lottery cycle silently (no chain).
// NEW code: the cycle must continue — results keep coming on cadence.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const req = createRequire(new URL('../package.json', import.meta.url));
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'wingo-flap',
  screenRes: '1x1',
  timezone: 'UTC',
  language: 'en',
};
const log = (tag, msg) =>
  console.log(
    `[${new Date().toISOString().slice(11, 19)}.${String(Date.now() % 1000).padStart(3, '0')}] ${tag} ${msg}`
  );

async function call(method, path, { body, token } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const phone = `+9237${10000000 + Math.floor(Math.random() * 89999999)}`;
const r = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: FP },
});
const token = r.json?.data?.accessToken;
if (!token) throw new Error('signup failed');
log('AUTH', 'logged in');

const sock = io('http://localhost:4000', {
  auth: { token },
  transports: ['websocket'],
});
sock.on('connect', () => sock.emit('game:join', { slug: 'wingo' }));

const results = []; // timestamps of wingo:result (30s)
let outageStart = 0,
  outageEnd = 0;
let injected = false;

sock.on('wingo:round-start', (p) => {
  if (p.durationSec !== 30 || injected) return;
  injected = true;
  const wait = Math.max(1000, p.endsAt - Date.now() - 6000);
  log(
    'FLAP',
    `round ${String(p.roundId).slice(0, 8)} — will cut Redis in ${Math.round(wait / 1000)}s, across its draw`
  );
  setTimeout(() => {
    outageStart = Date.now();
    log('FLAP', '✂ Redis connectivity cut for 9s (spans the draw moment)');
    spawn('bash', [
      '-c',
      'for i in $(seq 1 22); do redis-cli -p 56379 CLIENT KILL TYPE normal >/dev/null 2>&1; sleep 0.4; done',
    ]);
    setTimeout(() => {
      outageEnd = Date.now();
      log('FLAP', '⟳ connectivity restored');
    }, 9100);
  }, wait);
});
sock.on('wingo:result', (p) => {
  if (p.durationSec !== 30) return;
  results.push(Date.now());
  log(
    'WINGO',
    `🎲 result ${p.result} (${p.color}) round=${String(p.roundId).slice(0, 8)}`
  );
});
sock.on('wingo:betting-closed', (p) => {
  if (p.durationSec === 30) log('WINGO', '🔒 betting closed');
});

// watch: until we have 2 results after outageEnd (cap 150s)
const deadline = Date.now() + 150_000;
await new Promise((resolve) => {
  const iv = setInterval(() => {
    const postCount = outageEnd ? results.filter((t) => t > outageEnd).length : 0;
    if ((outageEnd && postCount >= 2) || Date.now() > deadline) {
      clearInterval(iv);
      resolve();
    }
  }, 400);
});
sock.disconnect();

console.log('\n════════ WINGO FLAP VERDICT ════════');
let pass = true;
const check = (ok, label) => {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) pass = false;
};
check(injected && outageEnd > 0, 'outage was injected across a draw moment');
const post = results.filter((t) => t > outageEnd);
check(
  post.length >= 2,
  `lottery kept cycling after the blip (${post.length} results post-outage)`
);
const outageMs = outageEnd - outageStart;
for (let i = 1; i < results.length; i++) {
  const gap = results[i] - results[i - 1];
  const mid = (results[i] + results[i - 1]) / 2;
  const intersectsOutage =
    outageEnd > 0 && mid > outageStart - outageMs && mid < outageEnd + outageMs;
  // A gap intersecting the blip can legitimately skip the draw that fell
  // inside it and then wait one full replacement period (+ recovery slack):
  // worst case ≈ outageMs + 2×30s-period + ~10s. Outside the blip the strict
  // 45s cadence rule applies. (Continuity itself is asserted by the
  // post-outage result/cadence checks below.)
  const bound = intersectsOutage ? outageMs + 75_000 : 45_000;
  check(
    gap < bound,
    `result gap ${Math.round(gap / 1000)}s < ${Math.round(bound / 1000)}s${intersectsOutage ? ' (spans the blip — one draw may be skipped)' : ''}`
  );
}
// cadence must be fully RESTORED after the outage (last observed gap ≈ 30s)
if (post.length >= 2) {
  const lastGap = post[post.length - 1] - post[post.length - 2];
  check(
    lastGap < 40_000,
    `cadence restored after blip (last gap ${Math.round(lastGap / 1000)}s ≈ 30s period)`
  );
}
if (outageEnd) {
  const firstPost = post[0];
  check(
    firstPost && firstPost - outageEnd < 45_000,
    `first post-outage result arrived ${firstPost ? Math.round((firstPost - outageEnd) / 1000) + 's' : '—'} after recovery`
  );
}
console.log(
  pass
    ? '\n🏁 WINGO CYCLE SURVIVED THE DRAW-TIME BLIP'
    : '\n💥 WINGO CYCLE DIED — see ❌ above'
);
process.exit(pass ? 0 : 1);
