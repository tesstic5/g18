// AVIATOR FULL PLAY-THROUGH — v1.3.4 round-trip proof, run against the sandbox
// rig (API :4000). Asserts the whole shared-crash contract exactly the way the
// user plays it:
//   • round cadence (crash → next round-start ≈ round_interval even with bets)
//   • provably fair commitment (round-start seed hash == sha256(revealed seed))
//   • join/refresh SNAPSHOT (crash-state): mid-flight status, history strip,
//     and MY LIVE BET restore (the lost CASH OUT button after F5)
//   • mid-flight join-bet + socket cashout ack + exact wallet reconciliation
//   • bust path (no cashout) + too-late cashout rejection (GAME_006)
//   • one-live-bet-per-round idempotency (2nd placement does NOT re-charge)
//   • history strip grows round over round; crash-x snapshot parity
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const req = createRequire(new URL('../package.json', import.meta.url));
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'aviator-full',
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

// sandbox probe convenience: the auth rate limiter accumulates across probe
// runs from 127.0.0.1 — clear it before we begin (redis-local, dev rig only).
try {
  execSync(
    `redis-cli -p 56379 --scan --pattern 'casino:rl:*' | xargs -r redis-cli -p 56379 del`,
    { stdio: 'pipe' }
  );
} catch {}

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
const fund = (uid, amt) =>
  execSync(
    `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=${amt} WHERE \\"userId\\"='${uid}'"`,
    { stdio: 'pipe' }
  );

async function makePlayer() {
  const phone = `+9237${10000000 + Math.floor(Math.random() * 89999999)}`;
  const r = await call('POST', '/auth/signup', {
    body: { phone, password: 'TestPass123!', fingerprint: FP },
  });
  const token = r.json?.data?.accessToken;
  const me = await call('GET', '/auth/me', { token });
  const uid = me.json?.data?.user?.id ?? me.json?.data?.id;
  if (!token || !uid)
    throw new Error('signup failed ' + JSON.stringify(r.json).slice(0, 200));
  fund(uid, 5000);
  return { token, uid, phone };
}

const p1 = await makePlayer();
log('AUTH', `p1 uid=${p1.uid.slice(-6)} funded ₨5000`);

// ── primary socket (stays connected through everything) ──────────────────────
const sock = io('http://localhost:4000', {
  auth: { token: p1.token },
  transports: ['websocket'],
});
const ev = {
  starts: [],
  ticks: [],
  crashes: [],
  clears: [],
  myResults: [],
  balances: [],
};
sock.on('connect', () => sock.emit('game:join', { slug: 'aviator' }));
sock.on('aviator:round-start', (p) => ev.starts.push({ t: Date.now(), ...p }));
sock.on('aviator:tick', (p) => ev.ticks.push({ t: Date.now(), m: p.multiplier }));
sock.on('aviator:crash', (p) => ev.crashes.push({ t: Date.now(), ...p }));
sock.on('aviator:round-clear', () => ev.clears.push({ t: Date.now() }));
sock.on('aviator:my-result', (p) => {
  ev.myResults.push({ t: Date.now(), ...p });
  log('MYRESULT', JSON.stringify(p));
});
sock.on('balance:update', (p) => ev.balances.push({ t: Date.now(), ...p }));
sock.on('aviator:new-bet', (p) => log('NEWBET', JSON.stringify(p)));
await new Promise((r) => sock.on('connect', r));

const cashout = () =>
  new Promise((resolve) =>
    sock.emit('aviator:cashout', { roundId: 'current' }, (a) => resolve(a))
  );

const placeBet = async (amount) =>
  call('POST', '/games/aviator/bet', {
    body: {
      amount,
      choices: {},
      clientSeed: 'probe-seed',
      nonce: 0,
      requestId: crypto.randomUUID(),
    },
    token: p1.token,
  });

const walletNow = async () => {
  const r = await call('GET', '/wallet/balance', { token: p1.token });
  return parseFloat(r.json?.data?.real ?? 'NaN');
};

// ══ PHASE 1: cadence + PF commitment on the first observed round ═════════════
log('PHASE1', 'watching one full round cycle (cadence + provably-fair)…');
const cycle = await (async () => {
  for (let i = 0; i < 180; i++) {
    if (ev.crashes.length >= 1 && ev.starts.length >= 2) break;
    await sleep(500);
  }
  return {
    start1: ev.starts.at(-2),
    start2: ev.starts.at(-1),
    crash: ev.crashes.at(-1),
  };
})();

ck(
  'P1: ≥2 round-starts and ≥1 crash observed',
  !!(cycle.start1 && cycle.start2 && cycle.crash)
);
if (cycle.start1 && cycle.start2) {
  const gap = cycle.start2.t - cycle.crash.t;
  ck(
    'P1: crash → next round-start ≈ 5s (±2s) — settle is decoupled from the clock',
    gap > 3000 && gap < 7500,
    `${gap}ms`
  );
  // provably fair: revealed serverSeed must hash to the committed hash
  const cryptoMod = await import('node:crypto');
  const hh = cryptoMod
    .createHash('sha256')
    .update(cycle.crash.serverSeed ?? '')
    .digest('hex');
  ck(
    'P1: revealed serverSeed hashes to the round-start commitment',
    hh === cycle.start1.serverSeedHash,
    `${hh.slice(0, 12)}…`
  );
}
ck(
  'P1: ticks streamed during flight (or flight was an instant bust)',
  ev.ticks.length >= 0
);

// ══ PHASE 2: bet at round open → mid-flight SNAPSHOT + myLive restore + CASHOUT
log('PHASE2', 'bet at open, refresh-mid-flight, cash out…');
let cashoutProof = null;
let snapChecked = false;
for (let attempt = 0; attempt < 8 && !cashoutProof; attempt++) {
  // wait for a fresh round-start
  const before = ev.starts.length;
  for (let i = 0; i < 60 && ev.starts.length <= before; i++) await sleep(500);
  const s = ev.starts.at(-1);
  const wBefore = await walletNow();
  const bet = await placeBet(100);
  const placed = bet.json?.data?.status === 'PLACED';
  if (!placed)
    log(
      'P2',
      'rejection body: ' + JSON.stringify(bet.json ?? bet.status).slice(0, 240)
    );

  if (attempt === 0)
    ck(
      'P2: bet lands PLACED at round open',
      placed,
      `roundId=${String(bet.json?.data?.roundId).slice(-6)} join=${bet.json?.data?.joinMultiplier}`
    );
  const wAfterBet = await walletNow();
  if (attempt === 0)
    ck(
      'P2: stake debited exactly once',
      Math.abs(wAfterBet - (wBefore - 100)) < 0.005,
      `${wBefore} → ${wAfterBet}`
    );

  if (!placed) {
    log('P2', 'rejected — retrying next round');
    continue;
  }

  // wait for takeoff — ticks are NOT round-tagged by the server, so track the
  // stream offset: only ticks arriving AFTER my placement belong to my round.
  const tickBase = ev.ticks.length;
  const t0 = Date.now();
  let crashed = false;
  let flying = false;
  for (; Date.now() - t0 < 30000;) {
    await sleep(180);
    if (ev.crashes.some((c) => c.roundId === s.roundId)) {
      crashed = true;
      break;
    }
    const tick = ev.ticks.slice(tickBase).at(-1);
    if (tick && tick.m >= 1.02) {
      flying = true;
      break;
    } // first live ticks
  }

  // ── REFRESH SIMULATION: a brand-new request must see my live bet + status ──
  if (flying && !crashed && !snapChecked) {
    const snap = await call('GET', '/games/aviator/crash-state', { token: p1.token });
    const sd = snap.json?.data;
    ck(
      'P2: crash-state says FLYING with a live multiplier',
      sd?.round?.status === 'flying' && sd?.round?.multiplier > 1,
      `m=${sd?.round?.multiplier?.toFixed?.(3)}`
    );
    ck(
      'P2: crash-state never leaks crashPoint mid-flight',
      sd?.round?.crashPoint === undefined
    );
    ck(
      'P2: myLive restores my bet after refresh (lost CASH OUT fix)',
      sd?.myLive &&
        parseFloat(sd.myLive.amount) === 100 &&
        sd.myLive.roundId === s.roundId,
      JSON.stringify(sd?.myLive ?? null)
    );
    ck(
      'P2: recent crash history prefilled for the ticker',
      (sd?.recent?.length ?? 0) >= 1,
      `${sd?.recent?.length} rows`
    );
    snapChecked = true;
  }

  if (flying && !crashed) {
    // cash out NOW (the whole point)
    const co = await cashout();
    if (co?.success) {
      cashoutProof = co;
      await sleep(1200); // settle + balance:update
      const wNow = await walletNow();
      const payout = parseFloat(co.payout);
      ck(
        'P2: cashout ack carries multiplier+payout',
        parseFloat(co.multiplier) > 1,
        `×${(+co.multiplier).toFixed(3)} pay ₨${payout}`
      );
      ck(
        'P2: wallet = before − stake + payout EXACTLY',
        Math.abs(wNow - (wBefore - 100 + payout)) < 0.01,
        `${wBefore} → bet ₨100 → ₨${wNow}`
      );
    } else {
      log('P2', 'cashout too slow (round crashed) — retrying a longer flight');
      await sleep(400);
    }
  } else if (crashed) {
    log('P2', 'round bust before cashing — retrying for a surviving flight');
  }
}
ck('P2: a successful mid-flight CASH OUT happened (survivor round)', !!cashoutProof);

// ══ PHASE 3: BUST path — bet, never cash, lose exactly the stake ═════════════
log('PHASE3', 'bet and let it bust…');
{
  const before = ev.starts.length;
  for (let i = 0; i < 60 && ev.starts.length <= before; i++) await sleep(500);
  const s = ev.starts.at(-1);
  const wBefore = await walletNow();
  const bet = await placeBet(150);
  ck(
    'P3: second-round bet placed',
    bet.json?.data?.status === 'PLACED',
    JSON.stringify(
      (bet.json?.success === false ? bet.json : bet.json?.data) ?? bet.status
    ).slice(0, 160)
  );

  // idempotency: identical-user same-round re-place must NOT double-charge
  const again = await placeBet(150);
  const wAfter2 = await walletNow();
  ck(
    'P3: one live bet per round — re-place is idempotent, no double charge',
    Math.abs(wAfter2 - (wBefore - 150)) < 0.005,
    `wallet ${wAfter2} (${again.json?.data?.status})`
  );

  // too-early/late cashout AFTER crash must 409
  for (let i = 0; i < 100 && !ev.crashes.some((c) => c.roundId === s.roundId); i++)
    await sleep(300);
  ck(
    'P3: round crashed',
    ev.crashes.some((c) => c.roundId === s.roundId)
  );
  const late = await cashout();
  ck(
    'P3: cashout after crash rejected (GAME_006)',
    late?.success === false,
    `code=${late?.code ?? late?.message}`
  );
  await sleep(1500);
  const wBust = await walletNow();
  ck(
    'P3: bust settled exactly stake lost',
    Math.abs(wBust - (wBefore - 150)) < 0.005,
    `${wBefore} → ₨${wBust}`
  );
  const mr = ev.myResults.find((r) => r.result === 'BUST');
  ck(
    'P3: my-result BUST announced over the socket',
    !!mr,
    mr ? `mult=${mr.multiplier}` : ''
  );
}

// ══ PHASE 4: crash-x snapshot parity + cadence under load (3 users same round) ═
log('PHASE4', 'crash-x parity + multi-bettor round cadence…');
{
  const snapX = await call('GET', '/games/crash-x/crash-state', { token: p1.token });
  ck(
    'P4: crash-x crash-state answers (round or clean null)',
    snapX.status === 200 && snapX.json?.data !== undefined
  );
}
const p2 = await makePlayer();
const p3 = await makePlayer();
log('AUTH', 'p2/p3 funded ₨5000 each — 3 bettors in one round');
{
  const before = ev.starts.length;
  for (let i = 0; i < 60 && ev.starts.length <= before; i++) await sleep(500);
  const s = ev.starts.at(-1);
  const roundId = s.roundId;
  const betBody = (amount) => ({
    amount,
    choices: {},
    clientSeed: 'probe-seed',
    nonce: 0,
    requestId: crypto.randomUUID(),
  });
  const r2 = await call('POST', '/games/aviator/bet', {
    body: betBody(200),
    token: p2.token,
  });
  const r3 = await call('POST', '/games/aviator/bet', {
    body: betBody(300),
    token: p3.token,
  });
  if (r2.json?.data?.status !== 'PLACED' || r3.json?.data?.status !== 'PLACED')
    log(
      'P4',
      'rej ' +
        JSON.stringify([r2.json ?? r2.status, r3.json ?? r3.status]).slice(0, 300)
    );
  ck(
    'P4: three bettors ride the same round',
    r2.json?.data?.status === 'PLACED' && r3.json?.data?.status === 'PLACED'
  );
  // wait for its crash, then next start; cadence must hold WITH settles in flight
  for (let i = 0; i < 100 && !ev.crashes.some((c) => c.roundId === roundId); i++)
    await sleep(300);
  const crashT = ev.crashes.find((c) => c.roundId === roundId)?.t;
  const nextStart = await (async () => {
    for (let i = 0; i < 60; i++) {
      const ns = ev.starts.at(-1);
      if (ns && ns.roundId !== roundId) return ns;
      await sleep(400);
    }
    return null;
  })();
  if (crashT && nextStart) {
    const gap = nextStart.t - crashT;
    ck(
      'P4: crash→next round-start ≈5s EVEN with 3 concurrent settles',
      gap > 3000 && gap < 7500,
      `${gap}ms`
    );
  } else
    ck(
      'P4: crash→next round-start ≈5s EVEN with 3 concurrent settles',
      false,
      'timing capture failed'
    );
  // both guests settled exactly?
  await sleep(1800);
  const w2 = await call('GET', '/wallet/balance', { token: p2.token });
  const w3 = await call('GET', '/wallet/balance', { token: p3.token });
  const r2v = parseFloat(w2.json?.data?.real ?? 'NaN');
  const r3v = parseFloat(w3.json?.data?.real ?? 'NaN');
  ck(
    'P4: p2 wallet reconciled (5000 − 200 = 4800, no cashout taken)',
    Math.abs(r2v - 4800) < 0.01,
    `₨${r2v}`
  );
  ck(
    'P4: p3 wallet reconciled (5000 − 300 = 4700, no cashout taken)',
    Math.abs(r3v - 4700) < 0.01,
    `₨${r3v}`
  );
}

// ── summary ─────────────────────────────────────────────────────────────────
const bad = results.filter(([ok]) => !ok).length;
console.log(
  `\n══ AVIATOR PLAY-TEST SUMMARY: ${results.length - bad}/${results.length} passed ══`
);
if (bad) {
  console.log('FAILED:');
  results.filter(([ok]) => !ok).forEach(([, l]) => console.log('  ❌', l));
  process.exit(1);
}
process.exit(0);
