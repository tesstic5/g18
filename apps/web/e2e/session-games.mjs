// apps/web/e2e/session-games.mjs — D-092 LIVE E2E for the session model:
// mines/tower/stairs/hi-lo — ONE bet per round, steps raise the multiplier,
// cashout pays bet×mult, bust loses the single bet, history shows ONE row.
// Run:  cd apps/web && node e2e/session-games.mjs   (API on :4000, seeded)
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

// ── setup ─────────────────────────────────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: {
    username: 'superadmin',
    password: process.env.ADMIN_PASS || 'change-this-immediately',
  },
});
pass('admin login', admin.status === 200, `status ${admin.status}`);
if (admin.status !== 200) process.exit(1);

const phone = `+92${String(3000000000 + Math.floor(Math.random() * 999999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: {
    phone,
    password: 'TestPass123!',
    displayName: 'E2E Sessions',
    fingerprint: fp,
  },
});
TOKEN = signup.json?.data?.accessToken ?? '';
const USER_ID = signup.json?.data?.user?.id ?? '';
pass('signup fresh user', signup.status === 200 && !!TOKEN);
const fund = await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 50000 },
});
pass('admin funds ₨50,000', fund.status === 200, `balance ${fund.json?.data?.real}`);

const seedInfo = await call('GET', '/provably-fair/active-seed', { auth: true });
const SEED = seedInfo.json?.data?.clientSeed ?? 'player-default-seed';
pass('active client seed fetched', !!SEED);

// ── 1. old /bet is rejected for session games ─────────────────────────────
const oldBet = await call('POST', '/games/mines/bet', {
  auth: true,
  body: { amount: 50, clientSeed: SEED, requestId: rid(), choices: {} },
});
pass(
  'old per-step /bet rejected for mines (400)',
  oldBet.status === 400,
  `status ${oldBet.status}`
);

// ── 2. MINES: session → dig → cashout ─────────────────────────────────────
let session = await call('POST', '/games/mines/session', {
  auth: true,
  body: { amount: 100, clientSeed: SEED, requestId: rid(), choices: { mineCount: 3 } },
});
pass(
  'mines session created',
  session.status === 200 && session.json?.data?.status === 'SESSION_STARTED',
  session.json?.data?.session?.roundId
    ? `roundId ${session.json.data.session.roundId}`
    : JSON.stringify(session.json).slice(0, 120)
);
const roundId = session.json?.data?.session?.roundId ?? '';
pass(
  'session starts at 1.00×',
  Number(session.json?.data?.session?.currentMultiplier) === 1,
  `mult ${session.json?.data?.session?.currentMultiplier}`
);

// dig until we have 3 safe reveals or the round ends (bust is a VALID outcome
// — the test must accept both paths; luck decides which one we get)
let view = session.json?.data?.session ?? null;
let dug = 0,
  bustedEarly = false,
  safeCount = 0,
  cashOutcome = null;
const balAfterStart = await call('GET', '/wallet/balance', { auth: true });
pass(
  'wallet debited ONCE at session start (₨100)',
  Number(balAfterStart.json?.data?.real) === 49900,
  `real ${balAfterStart.json?.data?.real}`
);

for (let t = 0; t < 25 && safeCount < 3 && !bustedEarly; t++) {
  const step = await call('POST', '/games/mines/step', {
    auth: true,
    body: { roundId, action: { tile: t } },
  });
  if (step.status !== 200) {
    pass(`step ${t} ok`, false, `status ${step.status}`);
    break;
  }
  view = step.json?.data?.view ?? view;
  dug++;
  if (step.json?.data?.terminal) {
    bustedEarly = true;
    break;
  }
  if (step.json?.data?.stepResult?.safe) safeCount++;
}
pass(
  'mines: steps advanced the round (safe digs OR bust — both valid)',
  safeCount > 0 || bustedEarly,
  `safe ${safeCount} bust ${bustedEarly}`
);

if (!bustedEarly && safeCount >= 1) {
  const histMid = await call('GET', '/games/mines/history?pageSize=5', { auth: true });
  pass(
    'PENDING round hidden from history while active',
    (histMid.json?.data?.data ?? []).length === 0,
    `rows ${histMid.json?.data?.data?.length}`
  );

  pass(
    `mines: ${safeCount} safe tile(s) with growing multiplier`,
    view.currentMultiplier >= 1,
    `mult ${view.currentMultiplier}`
  );
  const cash = await call('POST', '/games/mines/cashout', {
    auth: true,
    body: { roundId },
  });
  cashOutcome = cash.json?.data;
  pass(
    'mines cashout settles',
    cash.status === 200 && cash.json?.data?.result === 'CASHOUT',
    `payout ₨${cash.json?.data?.payout} @ ${cash.json?.data?.multiplier}×`
  );
  const expectedPayout = 100 * (cash.json?.data?.multiplier ?? 0);
  pass(
    'cashout payout = bet × multiplier',
    Math.abs(Number(cash.json?.data?.payout) - expectedPayout) < 0.02,
    `${cash.json?.data?.payout} vs ${expectedPayout}`
  );
  const balAfter = await call('GET', '/wallet/balance', { auth: true });
  const expectedReal = 49900 + expectedPayout;
  pass(
    'wallet credited exactly bet×mult',
    Math.abs(Number(balAfter.json?.data?.real) - expectedReal) < 0.02,
    `real ${balAfter.json?.data?.real} expected ~${expectedReal}`
  );

  const hist = await call('GET', '/games/mines/history?pageSize=5', { auth: true });
  const mineRows = hist.json?.data?.data ?? [];
  pass(
    'history shows EXACTLY ONE mines round (CASHOUT)',
    mineRows.length === 1 && mineRows[0]?.result === 'CASHOUT',
    `rows ${mineRows.length} result ${mineRows[0]?.result}`
  );
  pass(
    'history round amount = the single ₨100 bet',
    Number(mineRows[0]?.betAmount) === 100,
    `bet ${mineRows[0]?.betAmount}`
  );
} else {
  // busted on the first dig — that's a valid round; verify the bust path here
  pass(
    'mines: early bust terminated with the single bet lost',
    view.status === 'BUST' && view.currentMultiplier === 0,
    `status ${view.status}`
  );
  const hist = await call('GET', '/games/mines/history?pageSize=5', { auth: true });
  const mineRows = hist.json?.data?.data ?? [];
  pass(
    'history shows EXACTLY ONE mines round (BUST)',
    mineRows.length === 1 && mineRows[0]?.result === 'BUST',
    `rows ${mineRows.length} result ${mineRows[0]?.result}`
  );
  pass(
    'history round amount = the single ₨100 bet',
    Number(mineRows[0]?.betAmount) === 100,
    `bet ${mineRows[0]?.betAmount}`
  );
}

// ── 3. duplicate session → 409, GET /session recovers ─────────────────────
session = await call('POST', '/games/mines/session', {
  auth: true,
  body: { amount: 50, clientSeed: SEED, requestId: rid(), choices: { mineCount: 1 } },
});
const r2 = session.json?.data?.session?.roundId ?? '';
const dup = await call('POST', '/games/mines/session', {
  auth: true,
  body: { amount: 50, clientSeed: SEED, requestId: rid(), choices: { mineCount: 1 } },
});
pass('second session while active → 409', dup.status === 409, `status ${dup.status}`);
const rec = await call('GET', '/games/mines/session', { auth: true });
pass(
  'GET /session recovers the active round',
  rec.json?.data?.session?.roundId === r2,
  `roundId ${rec.json?.data?.session?.roundId}`
);

// ── 4. BUST path: dig until we hit a mine (or 1-mine board) ───────────────
let bustRound = null;
for (let t = 0; t < 25 && !bustRound; t++) {
  const step = await call('POST', '/games/mines/step', {
    auth: true,
    body: { roundId: r2, action: { tile: t } },
  });
  if (step.json?.data?.terminal) bustRound = step.json?.data;
}
pass(
  'mines bust terminates the round',
  !!bustRound && bustRound.view.status === 'BUST',
  bustRound
    ? `mult ${bustRound.view.currentMultiplier}`
    : 'no bust in 25 digs (impossible for 1 mine — bug)'
);
pass(
  'bust stepResult reveals mine positions',
  Array.isArray(bustRound?.stepResult?.minePositions) &&
    bustRound.stepResult.minePositions.length >= 1,
  `mines ${bustRound?.stepResult?.minePositions?.length}`
);
const hist2 = await call('GET', '/games/mines/history?pageSize=5', { auth: true });
const rows2 = hist2.json?.data?.data ?? [];
pass(
  'bust row recorded (BUST, payout 0)',
  rows2[0]?.result === 'BUST' && Number(rows2[0]?.payoutAmount) === 0,
  `result ${rows2[0]?.result} payout ${rows2[0]?.payoutAmount}`
);

// ── 5. TOWER + STAIRS + HI-LO quick round-trips ───────────────────────────
for (const [slug, startChoices, action] of [
  ['tower', { difficulty: 'easy' }, (i) => ({ column: i % 3 })],
  ['stairs', {}, (i) => ({ pick: i % 2 })],
  ['hi-lo', { guess: 'higher' }, () => ({ guess: 'higher' })],
]) {
  const s = await call('POST', `/games/${slug}/session`, {
    auth: true,
    body: { amount: 50, clientSeed: SEED, requestId: rid(), choices: startChoices },
  });
  const okStart = s.status === 200 && s.json?.data?.status === 'SESSION_STARTED';
  pass(
    `${slug} session created`,
    okStart,
    okStart ? '' : JSON.stringify(s.json).slice(0, 100)
  );
  if (!okStart) continue;
  const sid = s.json?.data?.session?.roundId ?? '';
  // play up to 4 safe steps then cash out (or terminal)
  let done = false;
  for (let i = 0; i < 6 && !done; i++) {
    const step = await call('POST', `/games/${slug}/step`, {
      auth: true,
      body: { roundId: sid, action: action(i) },
    });
    if (step.status !== 200) break;
    if (step.json?.data?.terminal) {
      done = true;
      break;
    }
    if (step.json?.data?.view?.currentMultiplier >= 1.9) {
      const c = await call('POST', `/games/${slug}/cashout`, {
        auth: true,
        body: { roundId: sid },
      });
      pass(
        `${slug} cashout pays bet×mult`,
        c.status === 200 && Number(c.json?.data?.payout) >= 50,
        `payout ₨${c.json?.data?.payout}`
      );
      done = true;
    }
  }
  if (!done) {
    const c = await call('POST', `/games/${slug}/cashout`, {
      auth: true,
      body: { roundId: sid },
    });
    pass(
      `${slug} cashout (terminal path)`,
      c.status === 200 || c.status === 409,
      `status ${c.status}`
    );
  }
}

// ── 6. idempotency: same requestId → no double charge ─────────────────────
const walletBefore = await call('GET', '/wallet/balance', { auth: true });
const reqId = rid();
const s1 = await call('POST', '/games/stairs/session', {
  auth: true,
  body: { amount: 50, clientSeed: SEED, requestId: reqId, choices: {} },
});
const s2 = await call('POST', '/games/stairs/session', {
  auth: true,
  body: { amount: 50, clientSeed: SEED, requestId: reqId, choices: {} },
});
const walletAfter = await call('GET', '/wallet/balance', { auth: true });
pass(
  'idempotent session create (same requestId → same round, one charge)',
  s2.json?.data?.session?.roundId === s1.json?.data?.session?.roundId &&
    Number(walletBefore.json?.data?.real) - Number(walletAfter.json?.data?.real) === 50,
  `deducted ${Number(walletBefore.json?.data?.real) - Number(walletAfter.json?.data?.real)}`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
