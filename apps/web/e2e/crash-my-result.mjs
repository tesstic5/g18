// apps/web/e2e/crash-my-result.mjs — LIVE E2E for D-090: the player's OWN crash
// result must arrive over socket ({slug}:my-result) with the exact settled
// multiplier/payout, and the DB history row must match it (screen == history).
// Run:  cd apps/web && node e2e/crash-my-result.mjs   (API on :4000, seeded)
import { io } from 'socket.io-client';

const B = 'http://localhost:4000/api/v1';
const results = [];
const pass = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ── setup: admin + fresh funded user ─────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: { username: 'superadmin', password: 'change-this-immediately' },
});
pass('admin login', admin.status === 200, `status ${admin.status}`);
if (admin.status !== 200) process.exit(1);

const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: {
    phone,
    password: 'TestPass123!',
    displayName: 'E2E CrashResult',
    fingerprint: fp,
  },
});
pass(
  'signup fresh user',
  signup.status === 200,
  signup.status === 200 ? '' : JSON.stringify(signup.json).slice(0, 140)
);
TOKEN = signup.json?.data?.accessToken ?? '';
const USER_ID = signup.json?.data?.user?.id ?? '';
const fund = await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 100000 },
});
pass('admin funds ₨100,000', fund.status === 200, `balance ${fund.json?.data?.real}`);

const seedInfo = await call('GET', '/provably-fair/active-seed', { auth: true });
const SEED = seedInfo.json?.data?.clientSeed ?? 'player-default-seed';
pass('active client seed fetched', !!SEED, SEED.slice(0, 12) + '…');

// ── socket: listen for the player's own result ───────────────────────────
const sock = io('http://localhost:4000', {
  auth: (cb) => cb({ token: TOKEN }),
  transports: ['websocket'],
  reconnection: false,
});
await new Promise((resolve, reject) => {
  sock.on('connect', resolve);
  sock.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket connect timeout')), 8000);
});
pass('socket authenticated', sock.connected);

const myResults = [];
sock.on('aviator:my-result', (r) => myResults.push(r));

// ── place the bet in the betting window ──────────────────────────────────
let placed = false;
let lastCode = '';
for (let i = 0; i < 240 && !placed; i++) {
  const r = await call('POST', '/games/aviator/bet', {
    auth: true,
    body: {
      amount: 25,
      walletType: 'AUTO',
      clientSeed: SEED,
      requestId: rid(),
      choices: {},
    },
  });
  if (r.status === 200 && r.json?.success && r.json?.data?.status === 'PLACED')
    placed = true;
  else {
    lastCode = r.json?.code ?? `HTTP${r.status}`;
    await sleep(400);
  }
}
pass('aviator bet PLACED', placed, placed ? '' : `last code ${lastCode}`);

// ── wait for the round to settle (fly ~5-90s worst case, budget 120s) ────
const deadline = Date.now() + 120_000;
while (myResults.length === 0 && Date.now() < deadline) await sleep(500);

pass(
  'player received aviator:my-result over socket',
  myResults.length > 0,
  myResults.length ? JSON.stringify(myResults[0]) : 'timeout 120s'
);

if (myResults.length > 0) {
  const mr = myResults[0];
  pass(
    'my-result has a real result',
    mr.result === 'CASHOUT' || mr.result === 'BUST',
    `result=${mr.result}`
  );
  pass(
    'my-result multiplier is a positive number',
    typeof mr.multiplier === 'number' && mr.multiplier >= 0,
    `mult=${mr.multiplier}`
  );
  pass(
    'my-result payout matches multiplier×bet',
    mr.result === 'BUST'
      ? mr.payout === 0
      : Math.abs(mr.payout - 25 * mr.multiplier) < 0.02,
    `payout=${mr.payout} (25×${mr.multiplier})`
  );

  // ── history must agree with the socket result (screen == history) ──────
  const hist = await call('GET', '/games/aviator/history?pageSize=1', { auth: true });
  const row = hist.json?.data?.data?.[0];
  pass(
    'history row exists for the settled round',
    !!row,
    row ? `result=${row.result} mult=${row.payoutMultiplier}` : 'no rows'
  );
  if (row) {
    const histResult = row.result === 'CASHOUT' ? 'CASHOUT' : 'BUST';
    pass(
      'history result matches socket my-result',
      histResult === mr.result,
      `history=${row.result} socket=${mr.result}`
    );
    const histMult = Number(row.payoutMultiplier);
    // BUST: history stores the PAYOUT multiplier (0); the socket multiplier is
    // the crash point shown as "crashed before M×" — both are correct.
    pass(
      'history multiplier matches socket multiplier',
      mr.result === 'BUST' ? histMult === 0 : Math.abs(histMult - mr.multiplier) < 0.01,
      `history=${histMult} socket=${mr.multiplier}`
    );
  }
}

sock.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
