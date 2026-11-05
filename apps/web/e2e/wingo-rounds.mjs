// apps/web/e2e/wingo-rounds.mjs — D-107 LIVE E2E: WinGo shared lottery rounds.
// Verifies: all 4 times run continuously (rounds endpoint), a real-money bet
// joins the 30s round via socket, the round settles at the draw, wingo:my-result
// arrives with the exact payout, the shared wingo:result matches, the DB round
// row + wallet are consistent, and bets are REJECTED inside the 5s lock window.
// Run: cd apps/web && node e2e/wingo-rounds.mjs (API on :4000, socket on :4000)
import { io } from 'socket.io-client';
import crypto from 'crypto';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── setup ─────────────────────────────────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: {
    username: 'superadmin',
    password: process.env.ADMIN_PASS || 'change-this-immediately',
  },
});
pass('admin login', admin.status === 200);
const phone = `+92${String(3000000000 + Math.floor(Math.random() * 999999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', displayName: 'E2E Wingo', fingerprint: fp },
});
TOKEN = signup.json?.data?.accessToken ?? '';
const USER_ID = signup.json?.data?.user?.id ?? '';
pass('signup', signup.status === 200 && !!TOKEN);
await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 200000 },
});
const bal0 = await call('GET', '/wallet/balance', { auth: true });
const REAL0 = Number(bal0.json?.data?.real ?? 0);
pass('funded (real balance)', REAL0 > 0, `₨${REAL0}`);

// ── 1. all four times run continuously ────────────────────────────────────
const rounds = await call('GET', '/games/wingo/rounds');
const rl = rounds.json?.data ?? [];
const durSet = new Set(rl.map((r) => r.durationSec));
pass(
  'rounds endpoint lists 4 live lottery times',
  rl.length === 4 && [30, 60, 180, 300].every((d) => durSet.has(d)),
  `[${[...durSet].join(',')}]`
);
const r30 = rl.find((r) => r.durationSec === 30);
pass(
  '30s round has period + countdown + seed hash',
  !!r30?.period && r30.remainingSec > 0 && !!r30.serverSeedHash,
  `period ${r30?.period} · ${r30?.remainingSec}s left`
);
pass(
  '30s round betting open (not in lock window)',
  r30?.bettingOpen === true || r30?.remainingSec > 5
);

// ── 2. join the 30s round via socket, settle at the draw ──────────────────
const sock = io('http://localhost:4000', {
  transports: ['websocket', 'polling'],
  auth: { token: TOKEN },
});
await new Promise((resolve, reject) => {
  sock.on('connect', resolve);
  sock.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket timeout')), 8000);
});

const events = { start: [], result: [], myResult: [], resultByRound: new Map() };
sock.on('wingo:round-start', (r) => events.start.push(r));
sock.on('wingo:result', (r) => {
  events.result.push(r);
  events.resultByRound.set(r.roundId, r);
});
sock.on('wingo:my-result', (r) => events.myResult.push(r));
sock.on('balance:update', (r) => {
  events.balance = r;
});

// wait for the CURRENT 30s round-start (or use the snapshot roundId)
let current = r30;
if (!events.start.find((s) => s.durationSec === 30)) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline && !events.start.find((s) => s.durationSec === 30))
    await sleep(200);
  current = events.start.find((s) => s.durationSec === 30) ?? r30;
}

// bet only if the round is inside the betting window
const remainingNow = Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000));
const BET = 100;
let ack = null;
if (remainingNow > 6) {
  const emitBet = () =>
    new Promise((resolve) => {
      sock.emit(
        'wingo:bet',
        {
          roundId: current.roundId,
          durationSec: 30,
          choice: 'green',
          amount: BET,
          requestId: rid(),
        },
        resolve
      );
    });
  ack = await emitBet();
  // The engine safely rejects a bet that lands mid-rotation with
  // "Round changed — please retry" — the client contract is to retry once
  // against the freshly-broadcast round (round-start already pushed above).
  if (
    ack &&
    ack.success === false &&
    /round changed/i.test(String(ack.message || ''))
  ) {
    const fresh = events.start.find((ev) => ev.durationSec === 30) ?? current;
    current = fresh;
    ack = await emitBet();
  }
}
pass(
  'socket wingo:bet accepted into the round',
  ack?.success === true,
  ack ? JSON.stringify(ack) : 'round too close — skipped'
);
const ROUND_ID = ack?.roundId ?? current.roundId;

if (ack?.success) {
  // wait for settlement (round draw) — up to 35s
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline && !events.myResult.length) await sleep(300);
  const my = events.myResult[0];
  const shared =
    events.resultByRound.get(ROUND_ID) ??
    events.result.find((r) => r.durationSec === 30);

  pass(
    'wingo:my-result received after the draw',
    !!my,
    my ? JSON.stringify(my) : 'none'
  );
  if (my) {
    const expectedMult = my.result === 'WIN' ? 2.4 : 0;
    pass(
      'my-result result is WIN/LOSE with matching multiplier',
      (my.result === 'WIN' || my.result === 'LOSE') &&
        Math.abs(my.multiplier - expectedMult) < 0.001,
      `result=${my.result} mult=${my.multiplier}`
    );
    pass(
      'my-result payout = bet × multiplier',
      Math.abs(my.payout - BET * expectedMult) < 0.02,
      `payout ${my.payout}`
    );
    pass(
      'my-result carries the winning number + color',
      typeof my.number === 'number' && !!my.color,
      `${my.number} ${my.color}`
    );
  }
  pass(
    'shared wingo:result matches the same round',
    shared?.roundId === ROUND_ID && shared.result === my?.number,
    shared ? `period ${shared.period} · number ${shared.result}` : 'none'
  );

  // wallet + DB consistency
  const bal1 = await call('GET', '/wallet/balance', { auth: true });
  const REAL1 = Number(bal1.json?.data?.real ?? 0);
  const expectedDelta = (my?.result === 'WIN' ? BET * 2.4 : 0) - BET;
  pass(
    'wallet reflects bet + payout exactly',
    Math.abs(REAL1 - REAL0 - expectedDelta) < 0.02,
    `Δ=${(REAL1 - REAL0).toFixed(2)} expected ${expectedDelta.toFixed(2)}`
  );

  const hist = await call('GET', '/games/wingo/history', { auth: true }).catch(
    () => null
  );
  const rows = hist?.json?.data?.data ?? [];
  const row = rows.find((x) => Number(x.betAmount) === BET);
  pass(
    'DB GameRound row exists for the joined round',
    !!row,
    row ? `result=${row.result} payout=${row.payoutAmount}` : 'none'
  );
  if (row) {
    pass(
      'DB row result matches the socket my-result',
      row.result === my?.result,
      `db=${row.result} socket=${my?.result}`
    );
    pass(
      'DB row payout matches the socket payout',
      Math.abs(Number(row.payoutAmount) - (my?.payout ?? 0)) < 0.02,
      `db=${row.payoutAmount} socket=${my?.payout}`
    );
  }

  // ── 3. bet lock: attempt inside the last 5 seconds → rejected ──────────
  // (only if we can still catch the lock window of the NEXT round)
  const lockDeadline = Date.now() + 40000;
  let lockedAck = null;
  while (Date.now() < lockDeadline) {
    const snap = await call('GET', '/games/wingo/rounds');
    const r = (snap.json?.data ?? []).find((x) => x.durationSec === 30);
    if (r && r.remainingSec <= 5 && r.remainingSec > 0) {
      lockedAck = await new Promise((resolve) => {
        sock.emit(
          'wingo:bet',
          {
            roundId: r.roundId,
            durationSec: 30,
            choice: 'violet',
            amount: 10,
            requestId: rid(),
          },
          resolve
        );
      });
      break;
    }
    await sleep(500);
  }
  pass(
    'socket bet REJECTED inside the 5s lock window',
    lockedAck &&
      lockedAck.success === false &&
      /closed|wait|lock/i.test(lockedAck.message ?? ''),
    lockedAck ? JSON.stringify(lockedAck) : 'window not caught'
  );
}

sock.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n══════════════════════════════════════════`);
console.log(
  `WINGO ROUNDS E2E RESULT: ${results.length - failed.length}/${results.length} passed`
);
process.exit(failed.length ? 1 : 0);
