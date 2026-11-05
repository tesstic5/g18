// wingo-difficulty.mjs — E2E proof for WingGo per-game difficulty tiers (v1.4.3).
// Drives the real rig: admin PATCHes difficulty, live odds change, bets settle at
// the preset's multipliers. Asserts:
//   1. wingo is difficultyCapable in the panel listing
//   2. effective live odds (GET /games/wingo/rounds payouts) follow the preset
//   3. round configSnapshot carries preset payouts + number_weights
//   4. a REAL winning 'big' bet settles at 1.92 (normal) / 1.5 (hard) / 1.3 (impossible)
// Restores difficulty to default afterwards.
// Run: node apps/web/e2e/wingo-difficulty.mjs
import { createRequire } from 'module';
import { execSync } from 'child_process';
const req = createRequire('/home/user/ccc/apps/web/package.json');
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'wingo-diff',
  screenRes: '1x1',
  timezone: 'UTC',
  language: 'en',
};
const log = (t, m) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${t} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ck = (label, ok, detail = '') => {
  results.push([ok, label]);
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const TIERS = {
  normal: { big: 1.92, violet: 4.8, number: 9.6 },
  hard: {
    big: 1.5,
    violet: 2.75,
    number: 5.5,
    weights: [15, 10, 10, 10, 10, 15, 10, 10, 10, 10],
  },
  impossible: {
    big: 1.3,
    violet: 1.95,
    number: 3.9,
    weights: [20, 10, 10, 10, 10, 20, 10, 10, 10, 10],
  },
};

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

// ── admin session ────────────────────────────────────────────────────────────
// panel auth = admin_token cookie + double-submit csrf_token (header must echo cookie)
async function adminSession() {
  const username = process.env.ADMIN_USERNAME || 'superadmin';
  const password = process.env.ADMIN_PASSWORD || 'change-this-immediately';
  const r = await fetch(API + '/panel/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await r.json().catch(() => null);
  const raw = r.headers.getSetCookie?.() ?? [];
  const cookies = Object.fromEntries(
    raw.map((c) =>
      c
        .split(';')[0]
        .split('=')
        .map((s, i) => (i ? decodeURIComponent(s) : s))
    )
  );
  const csrf = cookies['csrf_token'];
  const token = cookies['admin_token'] ?? json?.data?.token;
  if (!token || !csrf) return null;
  const headers = (extra = {}) => ({
    ...extra,
    Authorization: `Bearer ${token}`,
    Cookie: `admin_token=${token}; csrf_token=${csrf}`,
    'x-csrf-token': csrf,
  });
  return { token, csrf, headers };
}
const admin = await adminSession();
if (!admin) {
  console.log('FATAL: admin login failed');
  process.exit(2);
}

// wingo now difficultyCapable (panel listing shape varies — use detail endpoint)
async function adminReq(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: admin.headers(
      body !== undefined ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
{
  const pw0 = await adminReq('GET', '/panel/games/wingo');
  const d = pw0.json?.data ?? pw0.json;
  ck(
    'wingo difficultyCapable in panel detail',
    d?.difficultyCapable === true,
    `capable=${d?.difficultyCapable} difficulty=${d?.configJson?.difficulty ?? d?.difficulty ?? 'null'}`
  );
}

async function setDifficulty(level) {
  const r = await adminReq('PATCH', `/panel/games/wingo`, { difficulty: level });
  return r.status;
}
async function getPanelWingo() {
  const r = await adminReq('GET', '/panel/games/wingo');
  return r.json?.data ?? r.json;
}

// ── player session ───────────────────────────────────────────────────────────
const phone = `+9231${10000000 + Math.floor(Math.random() * 89999999)}`;
let r = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: FP },
});
let token = r.json?.data?.accessToken;
if (!token) {
  console.log('FATAL: signup', r.json);
  process.exit(2);
}
const me = await call('GET', '/auth/me', { token });
const uid = me.json?.data?.user?.id ?? me.json?.data?.id;
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=20000 WHERE \\"userId\\"='${uid}'"`,
  { stdio: 'pipe' }
);
log('AUTH', `player ${phone} funded`);

const sock = io('http://localhost:4000', {
  auth: { token },
  transports: ['websocket'],
});
await new Promise((res, rej) => {
  sock.on('connect', res);
  sock.on('connect_error', rej);
  setTimeout(rej, 8000);
});
const myResults = [];
sock.on('wingo:my-result', (p) => myResults.push(p));

function bet(amount) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    sock.emit(
      'wingo:bet',
      { durationSec: 30, choice: 'big', amount, requestId: crypto.randomUUID() },
      (a) => resolve({ ...a, ms: Date.now() - t0 })
    );
  });
}

async function liveOdds() {
  const r = await call('GET', '/games/wingo/rounds', { token });
  const row = (r.json?.data ?? []).find((x) => x.durationSec === 30);
  return row?.payouts;
}

async function snapshot30() {
  // GameRound rows carry the round-pinned configSnapshot per wingo bet
  const out = execSync(
    `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -tA -c "SELECT \\"configSnapshot\\"::text FROM \\"GameRound\\" WHERE \\"gameSlug\\"='wingo' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    { encoding: 'utf8' }
  ).trim();
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// place 'big' bets round after round until one WINS; return the settle record
async function betUntilWin(maxRounds = 8) {
  for (let i = 0; i < maxRounds; i++) {
    const before = myResults.length;
    let a = await bet(200);
    let guard = 0;
    while (!a?.success && guard++ < 12) {
      if (guard === 1) log('BET', `ack retry: ${JSON.stringify(a)}`);
      await sleep(2000);
      a = await bet(200);
    }
    if (!a?.success) {
      log('BET', `round ${i}: no bet accepted — skipping`);
      await sleep(4000);
      continue;
    }
    const roundId = a.roundId ?? a.data?.roundId;
    // wait for my-result for this round (≤ 40s)
    const t0 = Date.now();
    while (Date.now() - t0 < 42000) {
      const hit = myResults
        .slice(before)
        .find((m) => !roundId || m.roundId === roundId);
      if (hit) {
        if (hit.result === 'WIN' || hit.result === 'win' || hit.win === true)
          return hit;
        log('ROUND', `round lost (n=${hit.number}); trying again`);
        break;
      }
      await sleep(500);
    }
  }
  return null;
}

// ── tier walk ────────────────────────────────────────────────────────────────
async function runTier(name) {
  const t = TIERS[name];
  if (name !== 'normal') {
    const st = await setDifficulty(name);
    if (st !== 200 && st !== 204) {
      ck(`PATCH difficulty=${name} accepted`, false, `status ${st}`);
      return;
    }
    ck(`PATCH difficulty=${name} accepted`, true);
    const pw = await getPanelWingo();
    ck(
      `panel shows difficulty=${name}`,
      pw?.configJson?.difficulty === name,
      JSON.stringify(pw?.configJson?.difficulty)
    );
    await sleep(35_000); // let a fresh round open under the new tier
  }
  const odds = await liveOdds();
  const b = Number(odds?.big ?? odds?.['big/small'] ?? odds?.bigSmall);
  ck(
    `${name}: live odds big=${t.big}`,
    b === t.big,
    `got ${b} (${JSON.stringify(odds)})`
  );
  const win = await betUntilWin(); // after ≥1 bet, its GameRound row carries the round snapshot
  const snap = await snapshot30();
  const sp = snap?.configJson?.payouts ?? snap?.payouts ?? {};
  ck(
    `${name}: round snapshot big payout=${t.big}`,
    Number(sp.big ?? sp['big/small'] ?? sp.bigSmall) === t.big,
    JSON.stringify(snap?.configJson ?? snap)
  );
  if (t.weights) {
    const raw = snap?.configJson?.number_weights ?? snap?.number_weights;
    // snapshot stores [{number, weight}] — normalize to the flat preset array
    const w =
      Array.isArray(raw) && typeof raw[0] === 'object' ? raw.map((x) => x.weight) : raw;
    ck(
      `${name}: snapshot number_weights tilt`,
      JSON.stringify(w) === JSON.stringify(t.weights),
      JSON.stringify(w)
    );
  }
  if (!win) {
    ck(`${name}: got a winning big bet within 8 rounds`, false, 'no win observed');
    return;
  }
  const ratio = win.payout / 200;
  ck(
    `${name}: winning big bet pays ${t.big}×`,
    Math.abs(ratio - t.big) < 0.001,
    `payout=${win.payout} ratio=${ratio}`
  );
}

await runTier('normal');
await runTier('hard');
await runTier('impossible');

// ── restore + verify the world is back to normal ────────────────────────────
const rst = await setDifficulty(null);
await sleep(35_000);
const odds = await liveOdds();
ck(
  'restore: difficulty back to default (null accepted)',
  rst === 200 || rst === 204,
  `status ${rst}`
);
ck(
  'restore: live odds big back to 1.92',
  Number(odds?.big ?? odds?.['big/small'] ?? odds?.bigSmall) === 1.92,
  JSON.stringify(odds)
);

sock.close();
const fails = results.filter(([ok]) => !ok);
console.log(
  `\n═══ WINGO DIFFICULTY: ${results.length - fails.length}/${results.length} pass ═══`
);
process.exit(fails.length ? 1 : 0);
