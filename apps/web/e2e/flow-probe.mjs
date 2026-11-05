// Live probe: round lifecycles for aviator / crash-x / wingo against the
// local rig (API :4000, PG :55432, Redis :56379). Two users bet the same
// shared round; user A cashes out mid-flight; user B joins DURING the flight
// (the "join anytime" rule). Then Wingo 30s is watched for one full period.
import { createRequire } from 'node:module';

const req = createRequire(new URL('../package.json', import.meta.url));
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const rnd = () => `+9237${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const FP = { userAgent: 'probe', screenRes: '1x1', timezone: 'UTC', language: 'en' };

let cookie = '';
function saveCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const name = pair.split('=')[0].trim();
    cookie = cookie
      .split('; ')
      .filter((x) => x && !x.startsWith(name + '='))
      .concat(pair)
      .join('; ');
  }
}
const csrf = () =>
  cookie
    .split('; ')
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1] ?? '';

async function call(method, path, { body, token } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null), res: r };
}

const KNOWN = ['+923792383565', '+923713405842'];
async function signupUser() {
  const phone = KNOWN.shift() ?? rnd();
  const r = await call('POST', '/auth/login', {
    body: { phone, password: 'TestPass123!', fingerprint: FP },
  });
  const tok = r.json?.data?.accessToken;
  if (tok) return { phone, token: tok };
  const s = await call('POST', '/auth/signup', {
    body: { phone, password: 'TestPass123!', fingerprint: FP },
  });
  return { phone, token: s.json?.data?.accessToken };
}

// admin credit helper: give a user real balance via panel fund
async function fund(userToken, amount) {
  const me = await call('GET', '/auth/me', { token: userToken });
  const uid = me.json?.data?.user?.id;
  const adminLogin = await call('POST', '/panel/auth/login', {
    body: {
      username: 'superadmin',
      password: process.env.ADMIN_PASS || 'change-this-immediately',
    },
  });
  const adminCookies = adminLogin.res.headers.getSetCookie?.() ?? [];
  const adminCookie = adminCookies.map((c) => c.split(';')[0]).join('; ');
  const adminCsrf = adminCookies
    .find((c) => c.startsWith('csrf_token='))
    ?.split(';')[0]
    .split('=')[1];
  const fundR = await fetch(API + `/panel/users/${uid}/fund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie,
      'X-CSRF-Token': adminCsrf,
    },
    body: JSON.stringify({ walletType: 'real', amount, reason: 'probe funding' }),
  });
  return { fundStatus: fundR.status, body: await fundR.text().catch(() => '') };
}

const log = (tag, msg) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag} ${msg}`);

const A = await signupUser();
const B = await signupUser();
const fA = await fund(A.token, 5000);
const fB = await fund(B.token, 5000);
log('fund', `A=${fA.fundStatus} B=${fB.fundStatus}`);

// ── AVIATOR + CRASH-X lifecycle watchers ──────────────────────────────────
const roundLog = { aviator: [], 'crash-x': [] };
let aviatorBet = null;
let crashxBet = null;

function connectCrash(slug, user, label) {
  const sock = io('http://localhost:4000', {
    auth: { token: user.token },
    transports: ['websocket'],
  });
  sock.on(`${slug}:round-start`, (p) => {
    log(slug, `⏱ round-start id=${p.roundId?.slice(0, 8)} countdown=${p.countdown}`);
    roundLog[slug].push({ ev: 'start', at: Date.now(), ...p });
  });
  let lastTickAt = 0;
  sock.on(`${slug}:tick`, (p) => {
    const now = Date.now();
    if (now - lastTickAt > 400) {
      lastTickAt = now;
      log(slug, `   tick ${p.multiplier?.toFixed(2)}x`);
    }
  });
  sock.on(`${slug}:crash`, (p) => {
    log(slug, `💥 crash @ ${p.crashPoint}x round=${p.roundId?.slice(0, 8)}`);
    roundLog[slug].push({ ev: 'crash', at: Date.now(), ...p });
  });
  sock.on(`${slug}:player-cashout`, (p) =>
    log(slug, `   cashout seen: ${p.userId_masked} @ ${p.at}x (+${p.amount})`)
  );
  sock.on(`${slug}:my-result`, (p) =>
    log(slug, `   MY RESULT: ${p.result} mult=${p.multiplier} payout=${p.payout}`)
  );
  sock.on('connect', () => {
    sock.emit('game:join', { slug });
    log(slug, `${label} socket connected`);
  });
  return sock;
}
const sockA = connectCrash('aviator', A, 'A');
const sockB = connectCrash('aviator', B, 'B');

// wait for the NEXT aviator round-start, then orchestrate bets
await new Promise((resolve) => {
  const to = setTimeout(resolve, 45000); // hard cap
  let didBets = false;
  sockA.on('aviator:round-start', async (rs) => {
    if (didBets) return;
    didBets = true;
    const roundId = rs.roundId;
    log('AVI-BET', `A places ₨200 during countdown (round ${roundId.slice(0, 8)})`);
    const b1 = await call('POST', '/games/aviator/bet', {
      token: A.token,
      body: {
        amount: 200,
        requestId: crypto.randomUUID(),
        choices: {},
        clientSeed: 'probe-seed-a',
      },
    });
    log(
      'AVI-BET',
      `  A bet → ${b1.status} ${JSON.stringify(b1.json?.data ?? b1.json)}`
    );

    // user B joins MID-FLIGHT (wait for a tick showing >= 1.3x, then bet)
    let joined = false;
    sockB.on('aviator:tick', async (p) => {
      if (joined || p.multiplier < 1.3) return;
      joined = true;
      log('AVI-BET', `B joins MID-FLIGHT at ${p.multiplier.toFixed(2)}x — ₨150`);
      const b2 = await call('POST', '/games/aviator/bet', {
        token: B.token,
        body: {
          amount: 150,
          requestId: crypto.randomUUID(),
          choices: {},
          clientSeed: 'probe-seed-b',
        },
      });
      log(
        'AVI-BET',
        `  B bet → ${b2.status} joinMultiplier=${b2.json?.data?.joinMultiplier} status=${JSON.stringify(b2.json?.code ?? 'ok')}`
      );
    });

    // A cashes out at ~2x
    let cashed = false;
    sockA.on('aviator:tick', (p) => {
      if (cashed || p.multiplier < 2 || p.multiplier > 3.2) return;
      cashed = true;
      log('AVI-CASH', `A hits CASH OUT at ${p.multiplier.toFixed(2)}x`);
      sockA.emit('aviator:cashout', { roundId }, (r) =>
        log('AVI-CASH', `  ack=${JSON.stringify(r)}`)
      );
    });
    setTimeout(resolve, 60000); // resolve after full cycle
  });
});

// ── WINGO 30s lifecycle ───────────────────────────────────────────────────
log('WINGO', 'watching 30s lottery for one full period');
const wSock = io('http://localhost:4000', {
  auth: { token: A.token },
  transports: ['websocket'],
});
let wingoBetted = false;
let wingoRoundId = null;
await new Promise((resolve) => {
  const to = setTimeout(resolve, 80000);
  wSock.on('connect', () => log('WINGO', 'connected'));
  wSock.on('wingo:round-start', (p) => {
    if (p.durationSec !== 30) return;
    wingoRoundId = p.roundId;
    log(
      'WINGO',
      `⏱ round-start period=${p.period} endsAt+${Math.round((p.endsAt - Date.now()) / 1000)}s`
    );
    if (!wingoBetted) {
      wingoBetted = true;
      setTimeout(async () => {
        log(
          'WINGO',
          `A bets ₨100 on RED via socket (round ${String(p.roundId).slice(0, 8)})`
        );
        wSock.emit(
          'wingo:bet',
          {
            choice: 'red',
            amount: 100,
            durationSec: 30,
            requestId: crypto.randomUUID(),
          },
          (r) => log('WINGO', `  bet ack=${JSON.stringify(r)}`)
        );
      }, 3000);
      // and a LATE bet just before the lock (must be rejected)
      setTimeout(
        async () => {
          wSock.emit(
            'wingo:bet',
            {
              choice: 'big',
              amount: 50,
              durationSec: 30,
              requestId: crypto.randomUUID(),
            },
            (r) => log('WINGO', `  late bet (expect lock) ack=${JSON.stringify(r)}`)
          );
        },
        Math.max(0, p.endsAt - Date.now() - 4000)
      );
    }
  });
  wSock.on('wingo:betting-closed', (p) => {
    if (p.durationSec === 30) log('WINGO', '🔒 betting closed');
  });
  wSock.on('wingo:result', (p) => {
    if (p.durationSec !== 30) return;
    log('WINGO', `🎲 result: ${p.result} (${p.color}) period=${p.period}`);
  });
  wSock.on('wingo:my-result', (p) =>
    log('WINGO', `  MY RESULT: ${p.result} choice=${p.choice} payout=${p.payout}`)
  );
});

[sockA, sockB, wSock].forEach((s) => s.disconnect());
// summarize cadence
const r = roundLog.aviator;
for (let i = 1; i < r.length; i++) {
  if (r[i - 1].ev === 'crash' && r[i].ev === 'start') {
    log(
      'CADENCE',
      `crash → next round-start gap: ${((r[i].at - r[i - 1].at) / 1000).toFixed(1)}s`
    );
  }
}
log('DONE', 'probe finished');
process.exit(0);
