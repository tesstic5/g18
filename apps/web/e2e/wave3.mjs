// apps/web/e2e/wave3.mjs — D-094 LIVE E2E: plinko multi-ball (aggregate = Σ/N,
// payout = bet × aggregate, deterministic buckets), keno ball draw (20 unique
// balls, matches counted, payout per the seeded table), wingo (color/number
// payouts 2.4/4.8/9.6). Run: cd apps/web && node e2e/wave3.mjs (API on :4000)
const B = 'http://localhost:4000/api/v1';
const results = [];
const pass = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const rid = () => crypto.randomUUID();
const cookieMap = new Map();
let csrf = '';
let TOKEN = '';
function absorb(res) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const pair = sc.split(';')[0].trim();
    const i = pair.indexOf('=');
    if (i > 0) cookieMap.set(pair.slice(0, i), pair.slice(i + 1));
  }
  if (cookieMap.has('csrf_token')) csrf = cookieMap.get('csrf_token');
}
const cookieHeader = () =>
  [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
async function call(method, path, { body, auth = false, admin = false } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  if (admin) {
    h['x-csrf-token'] = csrf;
    h.Cookie = cookieHeader();
  }
  const res = await fetch(`${B}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(res);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}
const fp = { userAgent: 'e2e', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const bet = (slug, amount, choices) =>
  call('POST', `/games/${slug}/bet`, {
    auth: true,
    body: { amount, clientSeed: SEED, requestId: rid(), choices },
  });

// ── setup ─────────────────────────────────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: { username: 'superadmin', password: 'change-this-immediately' },
});
pass('admin login', admin.status === 200);
if (admin.status !== 200) process.exit(1);
const phone = `+92${String(3000000000 + Math.floor(Math.random() * 999999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', displayName: 'E2E Wave3', fingerprint: fp },
});
TOKEN = signup.json?.data?.accessToken ?? '';
const USER_ID = signup.json?.data?.user?.id ?? '';
pass('signup', signup.status === 200 && !!TOKEN);
await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 200000 },
});
const seedInfo = await call('GET', '/provably-fair/active-seed', { auth: true });
const SEED = seedInfo.json?.data?.clientSeed ?? 'player-default-seed';
pass('seed fetched', !!SEED);

// ── 1. PLINKO multi-ball: aggregate = Σ/N, payout = bet × aggregate ───────
{
  let ok = 0,
    total = 0;
  for (const balls of [1, 4, 8, 16]) {
    const r = await bet('plinko', 100, { rows: 12, risk: 'medium', balls });
    const d = r.json?.data;
    const mo = d?.mappedOutcome ?? {};
    const bs = mo.buckets ?? [];
    const mults = mo.bucketMultipliers ?? [];
    const mean = mults.reduce((s, m) => s + m, 0) / Math.max(1, mults.length);
    const good =
      r.status === 200 &&
      bs.length === balls &&
      mults.length === balls &&
      Math.abs(mo.aggregate - mean) < 0.001 &&
      Math.abs(d.payoutAmount - 100 * Math.min(mean, 100)) < 0.02;
    if (good) ok++;
    else console.log(`   plinko ${balls}b bad: ${JSON.stringify(mo).slice(0, 160)}`);
    total += 100 * (d?.payoutAmount ?? 0);
  }
  pass(
    'plinko: 1/4/8/16 balls — bucket count, aggregate = Σ/N, payout exact',
    ok === 4,
    `${ok}/4`
  );
}

// ── 2. PLINKO determinism: same seed+nonce+choices → same buckets ─────────
{
  const r1 = await bet('plinko', 50, { rows: 12, risk: 'high', balls: 8 });
  const r2 = await bet('plinko', 50, { rows: 12, risk: 'high', balls: 8 });
  // different requestIds → different nonces → different rawOutcomes; instead
  // verify idempotency: same requestId returns the SAME round
  const reqId = rid();
  const a = await call('POST', '/games/plinko/bet', {
    auth: true,
    body: {
      amount: 50,
      clientSeed: SEED,
      requestId: reqId,
      choices: { rows: 12, risk: 'medium', balls: 8 },
    },
  });
  const b = await call('POST', '/games/plinko/bet', {
    auth: true,
    body: {
      amount: 50,
      clientSeed: SEED,
      requestId: reqId,
      choices: { rows: 12, risk: 'medium', balls: 8 },
    },
  });
  pass(
    'plinko: idempotent requestId → same round, one charge',
    a.json?.data?.roundId === b.json?.data?.roundId &&
      a.status === 200 &&
      b.status === 200,
    `round ${a.json?.data?.roundId}`
  );
  void r1;
  void r2;
}

// ── 3. KENO: 20 unique drawn balls, matches counted, seeded table payout ──
{
  const picks = [1, 5, 12, 20, 33];
  const r = await bet('keno', 50, { picks });
  const d = r.json?.data;
  const mo = d?.mappedOutcome ?? {};
  const drawn = mo.drawn ?? [];
  const unique = new Set(drawn).size === drawn.length;
  const inRange = drawn.every((n) => n >= 1 && n <= 40);
  const matches = picks.filter((p) => drawn.includes(p)).length;
  // seeded 5_picks table: {1:1.72, 2:0.19, 3:0.09, 4:0.11, 5:25}
  const table = { 0: 0, 1: 1.72, 2: 0.19, 3: 0.09, 4: 0.11, 5: 25 };
  const expectMult = table[matches] ?? 0;
  const good =
    drawn.length === 20 &&
    unique &&
    inRange &&
    mo.matches === matches &&
    Math.abs(d.payoutMultiplier - expectMult) < 0.001 &&
    Math.abs(d.payoutAmount - 50 * expectMult) < 0.02;
  pass(
    'keno: 20 unique balls 1-40, matches counted, table payout exact',
    good,
    `matches ${matches} mult ${d?.payoutMultiplier} expected ${expectMult}`
  );
}

// ── 4. KENO: more rounds for consistency ──────────────────────────────────
{
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const picks = [2, 7, 11, 19, 24, 30, 36, 40];
    const r = await bet('keno', 25, { picks });
    const d = r.json?.data;
    const mo = d?.mappedOutcome ?? {};
    const matches = picks.filter((p) => (mo.drawn ?? []).includes(p)).length;
    const table = {
      0: 0,
      1: 0.05,
      2: 0.1,
      3: 0.15,
      4: 0.4,
      5: 0.8,
      6: 2.5,
      7: 8,
      8: 130,
    };
    const expectMult = table[matches] ?? 0;
    if (mo.matches === matches && Math.abs(d.payoutMultiplier - expectMult) < 0.001)
      ok++;
  }
  pass('keno: 10 more rounds consistent with the 8-pick table', ok === 10, `${ok}/10`);
}

let lastBalance = 0;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// ── 5. WINGO: REST adapter places the bet into the live shared round ─────
// (instant per-bet outcomes are gone since the shared-round overhaul — the
// REST route is a thin adapter: PLACED first, outcome at the draw. Mapping +
// payout math is covered by engine unit tests and the wingo-rounds /
// wingo-full-play live draws.)
{
  let placed = 0,
    tries = 0;
  let bal0 = null,
    firstRoundId = null;
  while (placed < 5 && tries < 25) {
    tries++;
    const choice = ['red', 'green', 'violet', 7, 'big', 'small'][placed % 6];
    const r = await bet('wingo', 50, { choice });
    const d = r.json?.data;
    if (d?.status !== 'PLACED' || !d?.roundId) {
      await sleepMs(3000);
      continue;
    } // GAME_008 during draw window
    bal0 ??= Number(d.newBalance?.real ?? d.newBalance) + 50;
    placed++;
    firstRoundId ??= d.roundId;
    lastBalance = Number(d.newBalance?.real ?? d.newBalance);
  }
  const expectedAfterStakes = (bal0 ?? 0) - 250;
  pass(
    'wingo REST adapter: 5 bets PLACED into shared rounds (balance debited)',
    placed === 5 &&
      !!firstRoundId &&
      Math.abs(lastBalance - expectedAfterStakes) < 0.02,
    `placed ${placed}/5 in ${tries} tries · lastBal ${lastBalance}`
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
