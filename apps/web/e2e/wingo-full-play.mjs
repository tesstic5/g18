// WINGO FULL PLAY-THROUGH — plays the lottery exactly like a player would and
// asserts the whole contract: 4 durations cycling, stacked bet matrix, dedupe,
// lock window, settlement math, wallet reconciliation, and the REST surfaces
// the client tabs consume. Run against the sandbox rig (API :4000).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const req = createRequire(new URL('../package.json', import.meta.url));
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'wingo-full',
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

const COLOR_OF = (n) => (n === 0 || n === 5 ? 'violet' : n % 2 === 1 ? 'green' : 'red');
const PAYOUT = {
  red: 2.4,
  green: 2.4,
  violet: 4.8,
  number: 9.6,
  big: 1.92,
  small: 1.92,
};
const wins = (choice, n) =>
  typeof choice === 'number'
    ? choice === n
    : choice === 'big'
      ? n >= 5
      : choice === 'small'
        ? n <= 4
        : choice === COLOR_OF(n);

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

// fresh player, funded via SQL (panel fund endpoint not used in probes)
const phone = `+9237${10000000 + Math.floor(Math.random() * 89999999)}`;
let r = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: FP },
});
let token = r.json?.data?.accessToken;
if (!token) {
  r = await call('POST', '/auth/login', {
    body: { phone: '+923792383565', password: 'TestPass123!', fingerprint: FP },
  });
  token = r.json?.data?.accessToken;
}
const me = await call('GET', '/auth/me', { token });
const uid = me.json?.data?.user?.id ?? me.json?.data?.id;
if (!token || !uid) {
  console.log('FATAL: no session', r.json);
  process.exit(2);
}
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=5000 WHERE \\"userId\\"='${uid}'"`,
  { stdio: 'pipe' }
);
const wall0 = 5000;
log('AUTH', `player ${phone} uid=${uid.slice(-6)} funded ₨${wall0}`);

// ── sockets ───────────────────────────────────────────────────────────────
const sock = io('http://localhost:4000', {
  auth: { token },
  transports: ['websocket'],
});
const rounds = { 30: {}, 60: {}, 180: {}, 300: {} }; // {start:{t,endsAt}, results:[{t,result}]}
const resultsById = {};
const myResults = [];
let balanceUpdates = [];
sock.on('connect', () => sock.emit('game:join', { slug: 'wingo' }));
sock.on('wingo:round-start', (p) => {
  const d = p.durationSec;
  rounds[d].lastStart = {
    t: Date.now(),
    endsAt: p.endsAt,
    serverNow: p.serverNow,
    roundId: p.roundId,
    period: p.period,
  };
  resultsById[p.roundId] = {
    durationSec: d,
    period: p.period,
    endsAt: p.endsAt,
    t: Date.now(),
  };
});
sock.on('wingo:result', (p) => {
  const d = p.durationSec;
  (rounds[d].results ??= []).push({
    t: Date.now(),
    number: p.result,
    color: p.color,
    roundId: p.roundId,
  });
  if (resultsById[p.roundId])
    resultsById[p.roundId].drawn = { t: Date.now(), number: p.result, color: p.color };
});
sock.on('wingo:my-result', (p) => {
  myResults.push({ t: Date.now(), ...p });
  log(
    'MYRESULT',
    `d=${p.durationSec} choice=${p.choice} n=${p.number} ${p.result} payout=${p.payout}`
  );
});
sock.on('balance:update', (p) => balanceUpdates.push(p));
sock.on('wingo:betting-closed', (p) => {
  if (p.durationSec === 30) log('LOCK', '30s betting closed (T-5s)');
});

// helper: one wingo bet with ack + timing
function bet(choice, amount, durationSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    sock.emit(
      'wingo:bet',
      { durationSec, choice, amount, requestId: crypto.randomUUID() },
      (a) => resolve({ ...a, ms: Date.now() - t0 })
    );
  });
}

// wait until a 30s round is young (>= 15s left) then run a fn
function onFresh30(minLeftMs, fn) {
  return new Promise((resolve) => {
    const h = (p) => {
      if (p.durationSec !== 30) return;
      const left = p.endsAt - Date.now();
      if (left >= minLeftMs) {
        sock.off('wingo:round-start', h);
        resolve(fn(p));
      }
    };
    sock.on('wingo:round-start', h);
    // maybe current round already fresh
    call('GET', '/games/wingo/rounds', { token }).then(({ json }) => {
      const cur = json?.data?.find?.((x) => x.durationSec === 30);
      if (cur && cur.remainingSec * 1000 >= minLeftMs && rounds[30].lastStart) {
        sock.off('wingo:round-start', h);
        resolve(fn(rounds[30].lastStart));
      }
    });
  });
}

// ═══ PHASE 1: duration board integrity (watch ~66s) ═══
log('P1', 'watching all four durations…');
await sleep(66000);

const r30 = rounds[30].results ?? [];
ck(
  '30s draws continuously (≥2 results in 66s window)',
  r30.length >= 2,
  `${r30.length} results`
);
const r60 = rounds[60].results ?? [];
ck('60s drew at least once in 66s window', r60.length >= 1, `${r60.length} results`);
{
  // long timers rarely emit round-start DURING the watch window (a 180/300s
  // round started before we connected emits nothing) — the live snapshot is
  // the source of truth the client itself uses.
  const snap = await call('GET', '/games/wingo/rounds', { token });
  const rows = snap.json?.data ?? [];
  const d180 = rows.find((x) => x.durationSec === 180),
    d300 = rows.find((x) => x.durationSec === 300);
  ck(
    '180s + 300s lotteries running (snapshot)',
    !!d180 && !!d300 && d180.remainingSec > 0 && d300.remainingSec > 0,
    `180s: ${d180?.remainingSec}s left, 300s: ${d300?.remainingSec}s left`
  );
  // also: round-start events we DID capture must have sane endsAt math
  const starts = Object.values(resultsById);
  if (starts.length)
    ck(
      'round-start endsAt ≈ start+duration (±2s)',
      starts.every(
        (s) =>
          s.t !== undefined && Math.abs(s.endsAt - (s.t + s.durationSec * 1000)) < 2000
      ),
      starts
        .map((s) => `${s.durationSec}s:${((s.endsAt - s.t) / 1000).toFixed(1)}s-window`)
        .join(' ')
    );
}
for (const d of [30, 60]) {
  const rs =
    resultsById &&
    Object.values(resultsById).filter((x) => x.durationSec === d && x.drawn);
  if (rs.length) {
    const skew = rs.map((x) => x.drawn.t - x.endsAt);
    ck(
      `${d}s reveal lands at countdown zero (skew ≤ 1s)`,
      Math.max(...skew.map(Math.abs)) <= 1000,
      `skew ${skew.map((s) => s + 'ms').join(',')}`
    );
  }
}
if (r30.length >= 2) {
  const gaps = [];
  const byRound = r30.map((x) => x.roundId);
  const starts = Object.entries(resultsById)
    .filter(([id]) => byRound.includes(id))
    .map(([, v]) => v);
  for (let i = 1; i < r30.length; i++) gaps.push(r30[i].t - r30[i - 1].t);
  ck(
    '30s cadence ~30s between results',
    gaps.every((g) => g >= 28000 && g <= 34000),
    gaps.map((g) => Math.round(g / 1000) + 's').join(',')
  );
}
// per-duration period continuity — v1.3.3: 30s periods must NEVER skip,
// even with 60s/180s rounds starting in between.
{
  const periods30 = Object.values(resultsById)
    .filter((x) => x.durationSec === 30 && x.drawn)
    .map((x) => BigInt(x.period))
    .sort((a, b) => (a < b ? -1 : 1));
  const periods60 = Object.values(resultsById)
    .filter((x) => x.durationSec === 60 && x.drawn)
    .map((x) => BigInt(x.period));
  if (periods30.length >= 2) {
    const deltas = periods30.slice(1).map((p, i) => Number(p - periods30[i]));
    ck(
      '30s period numbers contiguous (no skips from other boards)',
      deltas.every((d) => d === 1),
      `deltas: ${deltas.join(',')}`
    );
  }
  log(
    'PERIOD',
    `30s: ${periods30.map(String).join('→')} | 60s saw ${periods60.map(String).join(',') || 'none'}`
  );
}

// ═══ PHASE 2: full stacked bet matrix on one 30s round ═══
log('P2', 'placing the full matrix into one 30s round…');
let matrixRoundId = null;
let expectedSettleCount = 0;
await onFresh30(15000, async (rs) => {
  matrixRoundId = rs.roundId;
  const matrix = [
    ['red', 10],
    ['green', 10],
    ['violet', 10],
    [0, 10],
    [3, 10],
    ['big', 10],
    ['small', 10],
  ];
  for (const [choice, amt] of matrix) {
    const a = await bet(choice, amt, 30);
    if (a.success) expectedSettleCount++;
    else log('BET', `choice=${choice} REJECTED: ${a.message}`);
  }
  // double-tap dedupe: same choice, same round, fresh requestId
  const dup = await bet('red', 10, 30);
  log('DEDUPE', `second red ack success=${dup.success} (must NOT debit again)`);
  globalThis.__dup = dup;
});
ck(
  'all 7 stacked targets accepted into one round',
  expectedSettleCount === 7,
  `${expectedSettleCount}/7`
);
await sleep(400);
const bal = async () => {
  const w = await call('GET', '/wallet/balance', { token });
  return Number(w.json?.data?.real ?? NaN);
};
const balAfterBets = await bal();
ck(
  'each stack debited exactly once (₨70 total)',
  Math.abs(wall0 - 70 - balAfterBets) < 0.01,
  `balance now ${balAfterBets} (expected ${wall0 - 70})`
);

// ═══ PHASE 3: lock window ═══
log('P3', 'testing the 5s lock…');
await onFresh30(9000, async () => {
  // wait until ~4s left, bet must be rejected
  const cur = rounds[30].lastStart;
  const waitUntil = cur.endsAt - 4000 - Date.now();
  await sleep(Math.max(0, waitUntil));
  const late = await bet('red', 10, 30);
  ck('late bet at T-4s rejected', late.success === false, late.message || '');
  globalThis.__late = late;
});

// ═══ PHASE 4: wait for the matrix round's draw; verify settlement ═══
log('P4', 'awaiting the draw + settlement…');
const drawn = resultsById[matrixRoundId];
const deadline = Date.now() + 45000;
while (!drawn?.drawn && Date.now() < deadline) await sleep(250);
ck('matrix round produced a public result', !!drawn?.drawn);
if (drawn?.drawn) {
  const n = drawn.drawn.number;
  log('DRAW', `number ${n} (${drawn.drawn.color})`);
  await sleep(1500); // settle writes
  const mine = myResults.filter((m) => m.roundId === matrixRoundId);
  ck('one my-result per stacked bet (7)', mine.length === 7, `${mine.length}`);
  let payoutSum = 0;
  let mathOk = true;
  for (const m of mine) {
    const shouldWin = wins(m.choice, n);
    const expectPayout = shouldWin
      ? 10 * PAYOUT[typeof m.choice === 'number' ? 'number' : m.choice]
      : 0;
    const gotWin = m.result === 'WIN';
    const ok = gotWin === shouldWin && Math.abs(Number(m.payout) - expectPayout) < 0.01;
    if (!ok) {
      mathOk = false;
      log(
        'MATH',
        `choice=${m.choice} n=${n} result=${m.result} payout=${m.payout} expected win=${shouldWin} payout=${expectPayout}`
      );
    }
    payoutSum += Number(m.payout);
  }
  ck('settlement math correct for every stacked bet', mathOk);
  const balEnd = await bal();
  ck(
    'wallet = start − stakes + payouts (exact)',
    Math.abs(balEnd - (wall0 - 70 + payoutSum)) < 0.02,
    `got ${balEnd}, want ${(wall0 - 70 + payoutSum).toFixed(2)}`
  );
  ck(
    'balance:update socket pushed during settle',
    balanceUpdates.length > 0,
    `${balanceUpdates.length} pushes`
  );
}

// ═══ PHASE 5: REST surfaces the client tabs use ═══
log('P5', 'checking REST surfaces…');
const roundsSnap = await call('GET', '/games/wingo/rounds', { token });
const d30 = roundsSnap.json?.data?.find?.((x) => x.durationSec === 30);
ck('/rounds returns all four lotteries', (roundsSnap.json?.data?.length ?? 0) === 4);
if (d30)
  ck(
    'remainingSec tracks the timer',
    Math.abs(d30.remainingSec - (d30.endsAt - Date.now()) / 1000) < 2,
    `server=${d30.remainingSec}s live=${((d30.endsAt - Date.now()) / 1000).toFixed(1)}s`
  );
const recent = await call('GET', '/games/wingo/recent?duration=30', { token });
ck(
  '/recent?duration=30 returns recent results',
  (recent.json?.data?.length ?? 0) > 0,
  `${recent.json?.data?.length} rows`
);
// v1.3.4: /recent must serve the NEWEST tail — its last entry must be the most
// recent live draw this socket witnessed (previously lrange(0,99) froze on the
// oldest 100 draws once a board passed 100 periods).
{
  const lastDrawn = Object.values(resultsById)
    .filter((r) => r.durationSec === 30 && r.drawn)
    .at(-1);
  const tail = recent.json?.data?.at?.(-1);
  ck(
    '/recent tail == newest live draw (v1.3.4 stale-window fix)',
    !!lastDrawn &&
      !!tail &&
      String(tail.period) === String(lastDrawn.period) &&
      tail.number === lastDrawn.drawn.number,
    tail ? `tail period=${tail.period} n=${tail.number}` : 'empty'
  );
}
const list = await call(
  'GET',
  '/games/wingo/history-list?duration=30&page=1&pageSize=10',
  { token }
);
const listRows = list.json?.data?.data ?? list.json?.data ?? [];
ck(
  '/history-list duration=30 paginates',
  Array.isArray(listRows) && listRows.length > 0,
  `${Array.isArray(listRows) ? listRows.length : 'n/a'} rows`
);
// v1.3.4: real pagination — total is the list length (not the window size),
// page 1 is the newest page, page 2 is strictly older, and a page beyond the
// end is EMPTY rather than recycling old rows.
{
  const meta = list.json?.data ?? {};
  const llen = execSync(`redis-cli -p 56379 llen casino:wingo:history:30`, {
    encoding: 'utf8',
  }).trim();
  ck(
    '/history-list reports TRUE total (llen)',
    String(meta.total) === llen,
    `api=${meta.total} redis=${llen}`
  );
  if (Number(meta.total) > 10) {
    const page2 = await call(
      'GET',
      '/games/wingo/history-list?duration=30&page=2&pageSize=10',
      { token }
    );
    const p2rows = page2.json?.data?.data ?? [];
    const p1Periods = new Set(listRows.map((r) => String(r.period)));
    ck(
      'page 2 is strictly older (no overlap with page 1)',
      p2rows.length > 0 && p2rows.every((r) => !p1Periods.has(String(r.period))),
      `p2=${p2rows.length}`
    );
    const far = await call(
      'GET',
      `/games/wingo/history-list?duration=30&page=${Math.ceil(meta.total / 10) + 3}&pageSize=10`,
      { token }
    );
    ck(
      'page beyond total is empty (no infinite pager)',
      (far.json?.data?.data ?? []).length === 0
    );
  }
}
const mine30 = await call('GET', '/games/wingo/history?page=1&pageSize=10', { token });
const mineRows = mine30.json?.data?.data ?? [];
ck(
  '"My history" has my settled matrix bets',
  mineRows.length >= 7,
  `${mineRows.length} rows`
);

// ═══ PHASE 6: 60s duration plays independently — and SETTLES ═══
log('P6', 'one bet on the 1-Min board (will wait for its draw)…');
const b60 = await bet(5, 10, 60);
ck('60s bet accepted with its own round', b60.success === true && !!b60.roundId);

// ═══ PHASE 6b: wait for the 60s draw + check my settlement for it ═══
// ═══ PHASE 6b: wait for the 60s draw + check settlement + per-board history ═══
{
  const dl = Date.now() + 80_000;
  while (!resultsById[b60.roundId]?.drawn && Date.now() < dl) await sleep(500);
  ck('60s round drew and settled', !!resultsById[b60.roundId]?.drawn);
  if (resultsById[b60.roundId]?.drawn) {
    const n = resultsById[b60.roundId].drawn.number;
    const mine = myResults.filter((m) => m.roundId === b60.roundId);
    ck('60s my-result arrived', mine.length === 1, `${mine.length}`);
    if (mine.length) {
      const m = mine[0];
      const shouldWin = wins(5, n);
      const exp = shouldWin ? 10 * PAYOUT.number : 0;
      ck(
        '60s settlement math correct',
        (m.result === 'WIN') === shouldWin && Math.abs(Number(m.payout) - exp) < 0.01,
        `choice=5 n=${n} ${m.result} payout=${m.payout} (expected ${exp})`
      );
      ck('60s my-result tagged durationSec=60', Number(m.durationSec) === 60);
    }
  }
  // per-board My-history (v1.3.3)
  const myAll = await call('GET', '/games/wingo/history?page=1&pageSize=20', { token });
  const my30 = await call(
    'GET',
    '/games/wingo/history?page=1&pageSize=20&duration=30',
    { token }
  );
  const my60 = await call(
    'GET',
    '/games/wingo/history?page=1&pageSize=20&duration=60',
    { token }
  );
  const nAll = myAll.json?.data?.data?.length ?? -1;
  const n30 = my30.json?.data?.data?.length ?? -1;
  const n60 = my60.json?.data?.data?.length ?? -1;
  ck('My history without filter = all boards', nAll >= 8, `all=${nAll}`);
  ck('My history duration=30 → only 30s board rows', n30 === 7, `30s=${n30}`);
  ck('My history duration=60 → only 60s board rows', n60 === 1, `60s=${n60}`);
}

// ═══ PHASE 7: broke player is rejected ═══
log('P7', 'zero-balance rejection…');
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=0 WHERE \\"userId\\"='${uid}'"`,
  { stdio: 'pipe' }
);
const broke = await bet('red', 10, 30);
ck('₨0 balance → bet rejected politely', broke.success === false, broke.message || '');
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=5000 WHERE \\"userId\\"='${uid}'"`,
  { stdio: 'pipe' }
);

// ═══ PHASE 8: DB hygiene — nothing stuck PLACED for my round ═══
const stuck = execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -tAc "SELECT count(*) FROM \\"SharedRoundBet\\" WHERE \\"userId\\"='${uid}' AND status='PLACED'"`,
  { encoding: 'utf8' }
).trim();
ck('no stakes stuck in PLACED', stuck === '0', `PLACED=${stuck}`);
const grCount = execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -tAc "SELECT count(*) FROM \\"GameRound\\" WHERE \\"userId\\"='${uid}' AND \\"gameSlug\\"='wingo'"`,
  { encoding: 'utf8' }
).trim();
log('DB', `my settled wingo GameRounds: ${grCount}`);
ck(
  'every accepted bet produced a GameRound row (8: 7 matrix + 60s)',
  Number(grCount) === 8,
  grCount
);

sock.disconnect();
const fails = results.filter(([ok]) => !ok);
console.log(
  `\n════════ ${results.length - fails.length}/${results.length} passed ════════`
);
if (fails.length) {
  fails.forEach(([, l]) => console.log('FAIL:', l));
  process.exit(1);
}
process.exit(0);
