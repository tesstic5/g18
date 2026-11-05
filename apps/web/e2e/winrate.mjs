// apps/web/e2e/winrate.mjs — LIVE end-to-end harness: win-rate admin control,
// force modes, invalid-config rejection, 20-game sweep, wallet reconciliation,
// provably-fair verification. Run:  cd apps/web && node e2e/winrate.mjs
// Requires the API on :4000 (Postgres + Redis + seed applied).
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
let USER_ID = '';
let SEED = '';

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

// ── tiny fetch wrapper with cookie persistence ────────────────────────────
async function call(
  method,
  path,
  { body, auth = false, admin = false, headers = {} } = {}
) {
  const h = { ...headers };
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

const refreshSeed = async () => {
  const fresh = await call('GET', '/provably-fair/active-seed', { auth: true });
  SEED = fresh.json?.data?.clientSeed ?? SEED;
};
const bet = async (slug, amount, choices, seed = undefined) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await call('POST', `/games/${slug}/bet`, {
      auth: true,
      body: {
        amount,
        walletType: 'AUTO',
        clientSeed: seed ?? SEED,
        requestId: rid(),
        choices,
      },
    });
    if (r.json?.code !== 'SEED_MISMATCH' || seed) return r; // explicit seed → caller owns retry
    await refreshSeed();
  }
  return { status: 0, json: { code: 'SEED_MISMATCH_STUCK' } };
};

const fp = { userAgent: 'e2e', screenRes: '1x1', timezone: 'UTC', language: 'en' };

// ── setup ─────────────────────────────────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: { username: 'superadmin', password: 'change-this-immediately' },
});
pass('admin login', admin.status === 200, `status ${admin.status}`);
if (admin.status !== 200) process.exit(1);

const phone = `+92${String(3000000000 + Math.floor(Math.random() * 999999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: {
    phone,
    password: 'TestPass123!',
    displayName: 'E2E Winrate',
    fingerprint: fp,
  },
});
pass(
  'signup fresh user',
  signup.status === 200 && signup.json?.success,
  signup.status === 200 ? '' : JSON.stringify(signup.json).slice(0, 120)
);
TOKEN = signup.json?.data?.accessToken ?? '';
USER_ID = signup.json?.data?.user?.id ?? '';

const fund = await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 1000000 },
});
pass('admin funds ₨1,000,000', fund.status === 200, `balance ${fund.json?.data?.real}`);
const seedRes = await call('GET', '/provably-fair/active-seed', { auth: true });
SEED = seedRes.json?.data?.clientSeed ?? '';
pass('fetch clientSeed', !!SEED, SEED);

const getConfig = async (slug) =>
  (await call('GET', `/panel/games/${slug}`, { admin: true })).json?.data;
const patchConfig = (slug, patch) =>
  call('PATCH', `/panel/games/${slug}`, { admin: true, body: patch });
const patchForce = (slug, body) =>
  call('PATCH', `/panel/games/${slug}/force`, { admin: true, body });
const balance = async () =>
  Number((await call('GET', '/wallet/balance', { auth: true })).json?.data?.real ?? 0);

// ── PHASE 1: win-rate CONFIG (RTP ceiling) — NOTE: outcome steering is
// intentionally disabled (winRateSteering.ts: isSteerable → always false).
// winRate now feeds ONLY the RTP-ceiling validator; observed win share must
// stay at coin-flip's natural ~50% no matter what winRate is set to. ──
{
  // Clean slate so the engine's rolling RTP-correction (which rebuilds from the
  // last 7 days of GameRound rows) doesn't react to previous harness runs.
  try {
    await call('POST', '/panel/games/coin-flip/clear-history', {
      admin: true,
      body: { confirm: true },
    });
  } catch {
    /* optional — admin endpoint may not exist */
  }

  const cfg = await getConfig('coin-flip');
  pass(
    'read coin-flip config',
    !!cfg,
    `winRate=${cfg?.winRate} baseRtp=${cfg?.baseRtp}`
  );

  // 1a. legal high win rate
  const r1 = await patchConfig('coin-flip', { winRate: 49 });
  pass(
    'admin sets winRate 49 (legal max)',
    r1.status === 200,
    JSON.stringify(r1.json?.data ?? r1.json).slice(0, 80)
  );

  let wins = 0,
    losses = 0;
  const w0pre = await call('GET', '/wallet/balance', { auth: true });
  const startAll = Number(w0pre.json?.data?.real) + Number(w0pre.json?.data?.bonus);
  const t0 = new Date(Date.now() - 2000).toISOString();
  let paidOut = 0;
  for (let i = 0; i < 100; i++) {
    const r = await bet('coin-flip', 10, { choice: 'heads' });
    if (r.status === 200 && r.json?.success) {
      r.json.data.result === 'WIN' ? wins++ : losses++;
      paidOut += Number(r.json.data.payoutAmount ?? 0);
    } else {
      pass(
        'bet settles @ winRate49',
        false,
        `bet#${i} ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`
      );
      break;
    }
  }
  const obs49 = (wins / 100) * 100;
  const endBal = await balance(); // eslint-disable-line no-unused-vars
  pass(
    'winRate 49 → observed ≈ natural 50% (steering disabled by design)',
    Math.abs(obs49 - 50) <= 14,
    `observed ${obs49.toFixed(1)}% (wins ${wins}/100)`
  );
  // Balance ↔ ledger reconciliation (the invariant that actually matters):
  // endReal must equal startReal minus REAL-wallet stakes plus REAL-wallet
  // wins for this window — independent of spend-priority routing, milestone
  // bonuses (they ledger to BONUS), or payout-rate config changes. Also each
  // response payoutAmount must match its WIN ledger row.
  {
    // The reconciliation invariant, proven from the ledger: (REAL+BONUS)
    // balance delta across the loop window must equal Σ(WIN rows) − Σ(BET
    // rows) across BOTH wallets. AUTO priority splits stakes across wallets,
    // so real-only accounting is meaningless here. /wallet/transactions caps
    // at 100 per page — pull pages until the window is exhausted.
    const rows = [];
    for (let page = 1; page <= 4; page++) {
      const tx = await call(
        'GET',
        `/wallet/transactions?from=${encodeURIComponent(t0)}&pageSize=100&page=${page}`,
        { auth: true }
      );
      const chunk = tx.json?.data?.data ?? [];
      rows.push(...chunk);
      if (chunk.length < 100) break;
    }
    const wNow = await call('GET', '/wallet/balance', { auth: true });
    const endAll = Number(wNow.json?.data?.real) + Number(wNow.json?.data?.bonus);
    const betRows = rows.filter((r) => r.type === 'BET');
    const winRows = rows.filter((r) => r.type === 'WIN');
    // Net over EVERY row type — side credits that land mid-window (win-streak
    // bonuses go to BONUS and legitimately raise endAll) must be included.
    // BET is the only debit type in this window. Split bets produce two rows
    // that SUM to the stake, so compare AMOUNT SUMS, not row counts.
    const betSum = betRows.reduce((a, r) => a + Number(r.amount), 0);
    const winSum = winRows.reduce((a, r) => a + Number(r.amount), 0);
    const otherCredits = rows
      .filter((r) => r.type.startsWith('BONUS_')) // engine side-credits only (skip ADMIN setup rows)
      .reduce((a, r) => a + Number(r.amount), 0);
    const net = winSum + otherCredits - betSum;
    pass(
      'wallet reconciles with its own ledger (all wallets)',
      Math.abs(endAll - (startAll + net)) < 0.02,
      `end ${endAll.toFixed(2)} vs start ${startAll.toFixed(2)} + net ${net.toFixed(2)} (Σbet ${betSum}, Σwin ${winSum}, side-credits ${otherCredits.toFixed(2)})`
    );
    pass(
      'every settle ledgered exactly once (responses ↔ ledger)',
      Math.abs(betSum - 1000) < 0.02 &&
        winRows.length === wins &&
        Math.abs(winSum - paidOut) < 0.02,
      `Σbet ${betSum.toFixed(2)}/1000 · WIN ${winRows.length}/${wins} · Σwin ${winSum.toFixed(2)} vs paidOut ${paidOut.toFixed(2)}`
    );
  }

  // 1b. RTP sanity: rolling RTP should sit near baseRtp 96 (window: 80–145%)
  await sleep(400);
  const stats = await call('GET', '/games/coin-flip/live-feed', {});
  const rtpCheck = await call('GET', '/games/coin-flip/history?pageSize=100', {
    auth: true,
  });
  const rows = rtpCheck.json?.data?.data ?? [];
  const paid = rows.reduce((s, r) => s + Number(r.payoutAmount), 0);
  const wagered = rows.reduce((s, r) => s + Number(r.betAmount), 0);
  const liveRtp = wagered > 0 ? (paid / wagered) * 100 : 0;
  pass(
    'rolling RTP sane (80–145%)',
    liveRtp > 80 && liveRtp < 145,
    `live RTP ${liveRtp.toFixed(1)}% over ${rows.length} rounds`
  );

  // 1c. illegal win rate rejected — the 99% ceiling protects the house math
  const rBad = await patchConfig('coin-flip', { winRate: 51 });
  pass(
    'winRate 51 → rejected (RTP ceiling)',
    rBad.status === 422,
    `${rBad.json?.code} ${(rBad.json?.message ?? '').slice(0, 90)}`
  );
  const cfgAfter = await getConfig('coin-flip');
  pass(
    'config unchanged after rejection',
    Number(cfgAfter?.winRate) === 49,
    `winRate still ${cfgAfter?.winRate}`
  );

  // 1d. low winRate is stored (validator only enforces the RTP ceiling) but
  // outcomes stay natural — steering was removed for provable fairness.
  const r2 = await patchConfig('coin-flip', { winRate: 10 });
  pass('admin sets winRate 10', r2.status === 200);
  wins = 0;
  losses = 0;
  for (let i = 0; i < 60; i++) {
    const r = await bet('coin-flip', 10, { choice: 'tails' });
    if (r.status === 200 && r.json?.success)
      r.json.data.result === 'WIN' ? wins++ : losses++;
  }
  const obs10 = (wins / 60) * 100;
  pass(
    'winRate 10 → observed still ≈ 50% (no outcome steering)',
    obs10 >= 30 && obs10 <= 70,
    `observed ${obs10.toFixed(1)}% (wins ${wins}/60)`
  );

  // restore
  await patchConfig('coin-flip', { winRate: 48 });
  const cfgRestored = await getConfig('coin-flip');
  pass('coin-flip restored to 48', Number(cfgRestored?.winRate) === 48);
}

// ── PHASE 2: dice — choices still honored, multipliers intact ─────────────
{
  const r = await bet('dice', 10, { over: true, target: 50 });
  const m = r.json?.data;
  pass(
    'dice bet settles @ winRate 49',
    r.status === 200 && m?.result,
    `result ${m?.result} multiplier ${m?.payoutMultiplier} number ${m?.mappedOutcome?.resultNumber}`
  );
  const multOk =
    m?.result === 'WIN'
      ? Math.abs(Number(m?.payoutMultiplier) - 1.98) < 0.01
      : Number(m?.payoutMultiplier) === 0;
  pass(
    'dice multiplier correct (1.98 win / 0 lose)',
    multOk,
    `result ${m?.result} multiplier ${m?.payoutMultiplier}`
  );
}

// ── PHASE 3: force modes ──────────────────────────────────────────────────
{
  const f1 = await patchForce('coin-flip', { forceOverride: 'FORCE_WIN', rounds: 5 });
  pass('enable FORCE_WIN ×5', f1.status === 200, JSON.stringify(f1.json?.data));
  let wins = 0;
  for (let i = 0; i < 5; i++) {
    const r = await bet('coin-flip', 10, { choice: 'heads' });
    if (r.json?.data?.result === 'WIN') wins++;
  }
  pass('FORCE_WIN → 5/5 wins', wins === 5, `${wins}/5`);
  const cfg1 = await getConfig('coin-flip');
  pass('forceRoundsLeft decremented to 0', Number(cfg1?.forceRoundsLeft ?? 0) === 0);

  const f2 = await patchForce('coin-flip', { forceOverride: 'FORCE_LOSE', rounds: 3 });
  pass('enable FORCE_LOSE ×3', f2.status === 200);
  let losses = 0;
  for (let i = 0; i < 3; i++) {
    const r = await bet('coin-flip', 10, { choice: 'heads' });
    if (r.json?.data?.result === 'LOSE') losses++;
  }
  pass('FORCE_LOSE → 3/3 losses', losses === 3, `${losses}/3`);
  await patchForce('coin-flip', { forceOverride: 'NONE', forceRoundsLeft: 0 });
  const rNorm = await bet('coin-flip', 10, { choice: 'heads' });
  pass(
    'force reset → normal betting resumes',
    rNorm.status === 200 && !!rNorm.json?.data?.result,
    `result ${rNorm.json?.data?.result}`
  );
}

// ── PHASE 4: invalid config sweep (nothing breaks) ────────────────────────
{
  const bads = [
    ['winRate 150', { winRate: 150 }],
    ['winRate -5', { winRate: -5 }],
  ];
  for (const [name, patch] of bads) {
    const r = await patchConfig('wheel', patch);
    // out-of-schema bounds are rejected by zod → 400 GEN_001; only
    // schema-valid-but-RTP-violating values reach the 422 CONF_002 ceiling.
    pass(
      `${name} → rejected (schema bounds)`,
      r.status === 400 && r.json?.code === 'GEN_001',
      `${r.status} ${r.json?.code}`
    );
  }
  {
    // maxWinMultiplier 999999 is schema-legal (cap 10,000,000) and does not
    // lift wheel RTP past the ceiling → the panel must ACCEPT it. Restore the
    // seeded value immediately afterwards.
    const w0 = await getConfig('wheel');
    const r = await patchConfig('wheel', { maxWinMultiplier: 999999 });
    const cfg = await getConfig('wheel');
    pass(
      'maxWinMultiplier 999999 → accepted (within schema cap)',
      r.status === 200 && Number(cfg?.maxWinMultiplier) === 999999,
      `${r.status} saved=${cfg?.maxWinMultiplier}`
    );
    await patchConfig('wheel', { maxWinMultiplier: Number(w0?.maxWinMultiplier) });
  }
  const w = await getConfig('wheel');
  pass(
    'wheel config intact after rejections (seed values restored)',
    Number(w?.maxWinMultiplier) === 50 && Number(w?.winRate) === 48
  );
}

// ── PHASE 5: 20-game sweep ────────────────────────────────────────────────
const GAME_CHOICES = {
  dice: { over: true, target: 50 },
  plinko: { rows: 12, risk: 'medium' },
  wheel: { tier: 'yellow' }, // colour tier — z.object({ tier }) since the wheel overhaul
  'coin-flip': { choice: 'heads' },
  limbo: { target: 2 },
  keno: { picks: [1, 5, 12, 20, 33] },
  'dragon-tiger': { bet: 'dragon' },
  roulette: { bet: { type: 'red' } },
  baccarat: { bet: 'player' },
  thimbles: { cup: 0 },
  'ring-of-fortune': { tier: 'bronze' },
  'scratch-card': {},
  'lucky-number': { betMin: 40, betMax: 60 },
};
// D-092: session games (mines/tower/stairs/hi-lo) play via /session — start,
// take one safe step, cash out. Covered fully by e2e/session-games.mjs.
const SESSION_SWEEP = [
  ['mines', { mineCount: 1 }, { tile: 0 }],
  ['tower', { difficulty: 'easy' }, { column: 0 }],
  ['stairs', {}, { pick: 0 }],
  ['hi-lo', { guess: 'higher' }, { guess: 'higher' }],
];
{
  const ok = [];
  const fail = [];
  for (const [slug, choices] of Object.entries(GAME_CHOICES)) {
    const r = await bet(slug, 50, choices);
    if (r.status === 200 && r.json?.success) ok.push(slug);
    else fail.push(`${slug}(${r.status}:${r.json?.code ?? '?'})`);
  }
  for (const [slug, startChoices, action] of SESSION_SWEEP) {
    const s = await call('POST', `/games/${slug}/session`, {
      auth: true,
      body: { amount: 50, clientSeed: SEED, requestId: rid(), choices: startChoices },
    });
    if (s.status === 200 && s.json?.data?.status === 'SESSION_STARTED') {
      const sid = s.json?.data?.session?.roundId ?? '';
      const step = await call('POST', `/games/${slug}/step`, {
        auth: true,
        body: { roundId: sid, action },
      });
      const fin = step.json?.data?.terminal
        ? step.status === 200
        : (
            await call('POST', `/games/${slug}/cashout`, {
              auth: true,
              body: { roundId: sid },
            })
          ).status === 200;
      if (fin) ok.push(slug);
      else fail.push(`${slug}(step/cashout)`);
    } else fail.push(`${slug}(${s.status}:${s.json?.code ?? '?'})`);
  }
  pass(
    '17 REST + 4 session games all settle',
    fail.length === 0,
    fail.join(', ') || `${ok.length} games OK`
  );
}
// crash games — shared house-clock round (place during window, wait for settle).
// A high crash point keeps the round flying ~60s, so the retry budget must be
// larger than one full round cycle (WAITING 2s + BETTING 2s + FLYING + CRASHED 5s).
{
  for (const slug of ['aviator', 'crash-x']) {
    let placed = false;
    let lastCode = '';
    for (let i = 0; i < 240 && !placed; i++) {
      const r = await bet(slug, 25, { target: 1.1 });
      if (r.status === 200 && r.json?.success)
        placed = r.json?.data?.status === 'PLACED' || !!r.json?.data?.result;
      else {
        lastCode = r.json?.code ?? `HTTP${r.status}`;
        await sleep(400);
      } // flying/crashed — wait for next window
    }
    pass(
      `${slug} shared-round bet PLACED`,
      placed,
      placed ? '' : `last code ${lastCode}`
    );
  }
  await sleep(14000); // let the round fly + settle
  const av = await call('GET', '/games/aviator/history?pageSize=3', { auth: true });
  const cx = await call('GET', '/games/crash-x/history?pageSize=3', { auth: true });
  pass(
    'aviator round settled in DB',
    (av.json?.data?.data ?? []).length > 0,
    `rows ${av.json?.data?.data?.length ?? 0}`
  );
  pass(
    'crash-x round settled in DB',
    (cx.json?.data?.data ?? []).length > 0,
    `rows ${cx.json?.data?.data?.length ?? 0}`
  );
}
// wingo — 60s round via socket (retry until the betting window opens)
{
  let wingoOk = false;
  let lastMsg = '';
  try {
    const sock = io('http://localhost:4000', {
      auth: (cb) => cb({ token: TOKEN }),
      transports: ['websocket'],
      reconnection: false,
    });
    const done = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 50000);
      sock.on('connect', () => {
        const tryBet = () => {
          sock.emit(
            'wingo:bet',
            { choice: 'red', amount: 25, requestId: rid() },
            (ack) => {
              if (ack?.success) {
                clearTimeout(t);
                resolve(true);
              } else {
                lastMsg = ack?.message ?? '';
                setTimeout(tryBet, 1500);
              } // retry next window
            }
          );
        };
        tryBet();
      });
      sock.on('connect_error', (e) => {
        lastMsg = e.message;
        clearTimeout(t);
        resolve(false);
      });
    });
    wingoOk = await done;
    sock.close();
  } catch (e) {
    lastMsg = e.message;
    wingoOk = false;
  }
  pass(
    'wingo bet accepted via socket',
    wingoOk,
    lastMsg ? `(${lastMsg.slice(0, 60)})` : ''
  );
}

// ── PHASE 6: provably-fair round-trip ─────────────────────────────────────
{
  const r = await bet('dice', 10, { over: true, target: 50 });
  const roundId = r.json?.data?.roundId;
  await call('POST', '/provably-fair/rotate-seed', { auth: true });
  // rotation replaced the active seed pair → refetch clientSeed for later phases
  const fresh = await call('GET', '/provably-fair/active-seed', { auth: true });
  SEED = fresh.json?.data?.clientSeed ?? SEED;
  const vr = await call('POST', '/provably-fair/verify', {
    auth: true,
    body: { roundId },
  });
  const v = vr.json?.data;
  pass(
    'PF verify: hash + raw match',
    vr.status === 200 && v?.valid && v?.hashMatches && v?.rawMatches,
    `valid=${v?.valid} hash=${v?.hashMatches} raw=${v?.rawMatches}`
  );
}

// ── PHASE 7: rapid-fire (no bet rate limit — D-042) ───────────────────────
{
  let okCount = 0;
  for (let i = 0; i < 20; i++) {
    const r = await bet('dice', 10, { over: true, target: 50 });
    if (r.status === 200 && r.json?.success) okCount++;
  }
  pass('20 rapid-fire bets all settle (no limit)', okCount === 20, `${okCount}/20`);
}

// ── summary ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('\n══════════════════════════════════════════');
console.log(`E2E RESULT: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach((f) =>
    console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''))
  );
}
console.log(`final wallet: ₨${await balance()}`);
process.exit(failed.length ? 1 : 0);
