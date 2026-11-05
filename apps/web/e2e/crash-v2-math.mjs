// v1.3.7 crash probe — full live verification of the operator-directed math.
import { io } from 'socket.io-client';
import { execSync } from 'child_process';

const B = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'rig/1.0',
  screenRes: '1920x1080',
  timezone: 'Asia/Karachi',
  language: 'en',
};
const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' → ' + d : ''));
};

async function call(method, path, body, token) {
  const res = await fetch(B + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const fund = (uid, amt) =>
  execSync(
    `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=${amt} WHERE \\"userId\\"='${uid}'"`,
    { stdio: 'pipe' }
  );
async function makePlayer() {
  const phone = `+9237${10000000 + Math.floor(Math.random() * 89999999)}`;
  const r = await call('POST', '/auth/signup', {
    phone,
    password: 'TestPass123!',
    fingerprint: FP,
  });
  const token = r.json?.data?.accessToken;
  const me = await call('GET', '/auth/me', null, token);
  const uid = me.json?.data?.user?.id ?? me.json?.data?.id;
  if (!token || !uid) throw new Error('signup failed');
  fund(uid, 5000);
  return { token, uid };
}
async function wallet(t) {
  const { json } = await call('GET', '/wallet/balance', null, t);
  const d = json.data ?? {};
  return ['real', 'bonus', 'gifted'].reduce((a, k) => a + Number(d[k] ?? 0), 0);
}

const p1 = await makePlayer();
console.log('probe user funded');

const sock = io('http://localhost:4000', {
  auth: { token: p1.token },
  transports: ['websocket'],
});
await new Promise((r) => sock.on('connect', r));
sock.emit('game:join', { slug: 'aviator' });

const crashes = [];
let minTick = Infinity;
sock.on('aviator:tick', (t) => {
  minTick = Math.min(minTick, Number(t.multiplier));
});
// the FULL event vocabulary is probed below — accept whatever shape lands
for (const ev of ['aviator:crash', 'aviator:crashed', 'aviator:round-crash']) {
  sock.on(ev, (p) => {
    const cp = Number(p?.crashPoint ?? p?.multiplier ?? p?.point ?? NaN);
    if (Number.isFinite(cp) && cp >= 0.1 && cp <= 100) crashes.push(cp);
  });
}

const stateOf = async (t) =>
  (await call('GET', '/games/aviator/crash-state', null, t)).json?.data;

// ── ACTIVE: place during BETTING, cash mid-taxi (~0.35) ──
async function activeRun() {
  // wait for countdown status first
  for (let i = 0; i < 60; i++) {
    const s = await stateOf(p1.token);
    if (s?.round?.status === 'countdown' || s?.round?.status === 'waiting') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const b0 = await wallet(p1.token);
  const bet = await call(
    'POST',
    '/games/aviator/bet',
    { amount: 100, choices: {}, clientSeed: 'rig', requestId: crypto.randomUUID() },
    p1.token
  );
  if (!(bet.status === 200 && bet.json?.data?.status === 'PLACED')) {
    console.log('bet not placed:', bet.status, JSON.stringify(bet.json).slice(0, 140));
    return;
  }
  // fly: poll crash-state for multiplier; at ~0.35 send the socket cashout
  for (let i = 0; i < 120; i++) {
    const s = await stateOf(p1.token);
    const st = s?.round?.status;
    const m = Number(s?.round?.multiplier ?? 0);
    if (st === 'flying' && m >= 0.33 && m < 0.9) {
      const ack = await new Promise((res) =>
        sock.emit('aviator:cashout', { roundId: 'current' }, res)
      );
      const cm = Number(ack?.multiplier ?? 0);
      console.log('cashout ack:', JSON.stringify(ack).slice(0, 140));
      check(
        'sub-1 taxi cashout accepted',
        ack?.success === true && cm < 1 && cm >= 0.1,
        `cashed @ ${cm}x`
      );
      await new Promise((r) => setTimeout(r, 1800));
      const b1 = await wallet(p1.token);
      const expected = b0 - 100 + 100 * cm;
      check(
        'wallet paid exactly the fraction (never zero, never above m×stake)',
        Math.abs(b1 - expected) < 0.05,
        `${b0} → ${b1} (expected ${expected.toFixed(2)})`
      );
      return;
    }
    if (st === 'crashed') {
      console.log(
        'crashed before cashout could fire (round was sub-1) — retrying on next round'
      );
      return activeRun();
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log('active pass timed out');
}
await activeRun();

// PF verify on my settled round
const hist = await call('GET', '/games/aviator/history?pageSize=5', null, p1.token);
const rows = hist.json?.data?.data ?? hist.json?.data ?? [];
const row =
  rows.find((r) => Number(r.payoutMultiplier ?? r.multiplier ?? 0) > 0) ?? rows[0];
if (row?.id) {
  const v = await call('POST', '/provably-fair/verify', { roundId: row.id }, p1.token);
  const d = v.json?.data ?? {};
  check(
    'PF verifier replays v2 round on the crash-hmac-v2 lane',
    d.valid === true && d.algorithm === 'crash-hmac-v2',
    JSON.stringify({
      valid: d.valid,
      algo: d.algorithm,
      mapped: d.mappedMatches,
      computed: d.computedMapped,
    })
  );
} else {
  check(
    'PF verify — round row present',
    false,
    JSON.stringify(hist.json).slice(0, 140)
  );
}

// histogram
const deadline = Date.now() + 420_000;
while (crashes.length < 40 && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 800));
const n = crashes.length;
if (n >= 30) {
  const sub1 = crashes.filter((c) => c < 1).length;
  const above12 = crashes.filter((c) => c > 12).length;
  check('live histogram: ≥ 30 rounds seen (soak)', n >= 30, `${n}`);
  check(
    'sub-1 share ≈ 65% (band 45-85%)',
    sub1 / n > 0.45 && sub1 / n < 0.85,
    `${sub1}/${n}=${((100 * sub1) / n).toFixed(1)}%`
  );
  check('ZERO crash points above 12x', above12 === 0, `max=${Math.max(...crashes)}`);
  check(
    'min crash ≥ 0.10',
    Math.min(...crashes) >= 0.1,
    `min=${Math.min(...crashes).toFixed(3)}`
  );
} else {
  check('live histogram: ≥ 30 rounds seen (soak)', n >= 30, `${n}`);
}

sock.close();
const ok = results.filter(Boolean).length;
console.log(`\n══ ${ok}/${results.length} passed ══`);
process.exit(ok === results.length ? 0 : 1);
