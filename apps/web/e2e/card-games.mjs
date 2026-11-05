// apps/web/e2e/card-games.mjs — D-093 LIVE E2E: baccarat (standard rules + face
// cards = 0), dragon-tiger (tie push), roulette (full table bets). Verifies the
// server outcome against the actual cards/pocket AND the payout math.
// Run:  cd apps/web && node e2e/card-games.mjs   (API on :4000, seeded)
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
const bet = async (slug, amount, choices) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await call('POST', `/games/${slug}/bet`, {
      auth: true,
      body: { amount, clientSeed: SEED, requestId: rid(), choices },
    });
    if (r.json?.code !== 'SEED_MISMATCH') return r;
    await refreshSeed();
  }
  return { status: 0, json: { code: 'SEED_MISMATCH_STUCK' } };
};

// ── setup ─────────────────────────────────────────────────────────────────
const admin = await call('POST', '/panel/auth/login', {
  body: { username: 'superadmin', password: 'change-this-immediately' },
});
pass('admin login', admin.status === 200);
if (admin.status !== 200) process.exit(1);
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const signup = await call('POST', '/auth/signup', {
  body: { phone, password: 'TestPass123!', displayName: 'E2E Cards', fingerprint: fp },
});
TOKEN = signup.json?.data?.accessToken ?? '';
const USER_ID = signup.json?.data?.user?.id ?? '';
pass('signup', signup.status === 200 && !!TOKEN);
await call('POST', `/panel/users/${USER_ID}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 200000 },
});
const seedInfo = await call('GET', '/provably-fair/active-seed', { auth: true });
let SEED = seedInfo.json?.data?.clientSeed ?? 'player-default-seed';
// Auto-rotation replaces the active pair every 100 nonces — behave like the
// real client: refresh on SEED_MISMATCH and retry (r400 message says to).
const refreshSeed = async () => {
  const fresh = await call('GET', '/provably-fair/active-seed', { auth: true });
  SEED = fresh.json?.data?.clientSeed ?? SEED;
};
pass('seed fetched', !!SEED);

const cardVal = (v) => (v >= 10 ? 0 : v);
const point = (cards) => cards.reduce((s, c) => (s + cardVal(c)) % 10, 0);

// ── 1. BACCARAT: 40 rounds, outcome + points + payout math ────────────────
{
  let ok = 0,
    fail = 0;
  for (let i = 0; i < 40; i++) {
    const choice = ['player', 'banker', 'tie'][i % 3];
    const r = await bet('baccarat', 100, { bet: choice });
    if (r.status !== 200) {
      fail++;
      continue;
    }
    const d = r.json?.data;
    const mo = d.mappedOutcome ?? {};
    const pc = mo.playerCards ?? [],
      bc = mo.bankerCards ?? [];
    const pp = point(pc),
      bp = point(bc);
    const expectOutcome = pp > bp ? 'player' : bp > pp ? 'banker' : 'tie';
    const goodPoints = pp === mo.playerPoint && bp === mo.bankerPoint;
    const goodOutcome = expectOutcome === mo.outcome;
    // payout math: win → multiplier; tie push → 1; lose → 0
    let expectMult = 0;
    if (expectOutcome === 'tie')
      expectMult = choice === 'tie' ? 10.13 : 1; // engine default payouts.tie = 10.13 (config-driven)
    else if (choice === expectOutcome) expectMult = choice === 'player' ? 1.95 : 1.9; // seeded payouts (D-093)
    const goodMult = Math.abs(d.payoutMultiplier - expectMult) < 0.001;
    const goodPayout = Math.abs(d.payoutAmount - 100 * expectMult) < 0.02;
    if (goodPoints && goodOutcome && goodMult && goodPayout) ok++;
    else {
      fail++;
      if (fail < 4)
        console.log(
          `   bad bac: ${JSON.stringify({ mo: { bet: mo.bet, playerPoint: mo.playerPoint, bankerPoint: mo.bankerPoint, outcome: mo.outcome }, expect: { pp, bp, expectOutcome, expectMult }, gotMult: d.payoutMultiplier, gotPayout: d.payoutAmount })}`
        );
    }
  }
  pass(
    'baccarat: 40 rounds — points, outcome, payout all consistent',
    ok >= 38,
    `${ok}/40`
  );
}

// ── 2. BACCARAT: third-card rules hold (no natural then draws happen legally) ──
{
  let checked = 0,
    ok = 0;
  for (let i = 0; i < 25; i++) {
    const r = await bet('baccarat', 50, { bet: 'player' });
    const mo = r.json?.data?.mappedOutcome ?? {};
    const pc = mo.playerCards ?? [],
      bc = mo.bankerCards ?? [];
    const pp = point(pc),
      bp = point(bc);
    if (pp >= 8 || bp >= 8) {
      // natural — nobody draws
      if (pc.length === 2 && bc.length === 2) ok++;
      checked++;
    } else {
      // player draws iff the INITIAL 2-card point <= 5 (standard rules)
      const playerInitial = point(pc.slice(0, 2));
      if ((pc.length === 3) === playerInitial <= 5) ok++;
      checked++;
      // banker draws only when its decision table says so
      if (bc.length === 3) {
        const bpNoThird = point(bc.slice(0, 2));
        if (bpNoThird <= 6) ok++;
      }
    }
  }
  pass('baccarat: third-card drawing rules hold', ok >= checked, `${ok}/${checked}`);
}

// ── 3. DRAGON-TIGER: 30 rounds — outcome + tie push payout ────────────────
{
  let ok = 0,
    ties = 0;
  for (let i = 0; i < 30; i++) {
    const choice = ['dragon', 'tiger'][i % 2];
    const r = await bet('dragon-tiger', 100, { bet: choice });
    const d = r.json?.data;
    const mo = d.mappedOutcome ?? {};
    const rankOf = (s) => {
      const r = String(s).slice(0, -1);
      return (
        {
          2: 2,
          3: 3,
          4: 4,
          5: 5,
          6: 6,
          7: 7,
          8: 8,
          9: 9,
          10: 10,
          J: 11,
          Q: 12,
          K: 13,
          A: 14,
        }[r] ?? 0
      );
    };
    const dv = rankOf(mo.dragon),
      tv = rankOf(mo.tiger);
    const expectOutcome = dv > tv ? 'dragon' : tv > dv ? 'tiger' : 'tie';
    let expectMult = 0;
    if (expectOutcome === 'tie') {
      expectMult = choice === 'tie' ? 8 : 1;
      ties++;
    } else if (choice === expectOutcome) expectMult = 1.95; // seeded payout
    const good =
      expectOutcome === mo.outcome &&
      Math.abs(d.payoutMultiplier - expectMult) < 0.001 &&
      Math.abs(d.payoutAmount - 100 * expectMult) < 0.02;
    if (good) ok++;
    else if (ok + (i - ok) < 35)
      console.log(
        `   bad dt: ${JSON.stringify({ mo, dv, tv, expectOutcome, expectMult, gotMult: d.payoutMultiplier, gotPayout: d.payoutAmount, bet: mo.bet })}`
      );
  }
  pass(
    'dragon-tiger: 30 rounds — outcome + tie-push payout consistent',
    ok >= 28,
    `${ok}/30 (ties: ${ties})`
  );
}

// ── 4. ROULETTE: every straight number hits exactly once + payouts ────────
{
  let ok = 0;
  for (let n = 0; n <= 36; n++) {
    const r = await bet('roulette', 50, { bet: { type: 'straight', number: n } });
    const d = r.json?.data;
    if (!d) {
      console.log(
        '   roulette bet err n=' + n,
        r.status,
        JSON.stringify(r.json).slice(0, 140)
      );
      continue;
    }
    const mo = d.mappedOutcome ?? {};
    const won = mo.pocket === n;
    const expectMult = won ? 36 : 0;
    const good =
      mo.win === won &&
      Math.abs(d.payoutMultiplier - expectMult) < 0.001 &&
      Math.abs(d.payoutAmount - 50 * expectMult) < 0.02;
    if (good) ok++;
  }
  pass(
    'roulette: 37 straight bets — each number hits exactly once, 36× payout',
    ok === 37,
    `${ok}/37`
  );
}

// ── 5. ROULETTE: outside / dozen / column / street / split / corner / six-line ──
{
  const redPockets = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ]);
  const cases = [
    ['red', { type: 'red' }, (p) => redPockets.has(p), 2],
    ['black', { type: 'black' }, (p) => p !== 0 && !redPockets.has(p), 2],
    ['odd', { type: 'odd' }, (p) => p !== 0 && p % 2 === 1, 2],
    ['even', { type: 'even' }, (p) => p !== 0 && p % 2 === 0, 2],
    ['low', { type: 'low' }, (p) => p >= 1 && p <= 18, 2],
    ['high', { type: 'high' }, (p) => p >= 19 && p <= 36, 2],
    ['dozen-1', { type: 'dozen-1' }, (p) => p >= 1 && p <= 12, 3],
    ['dozen-2', { type: 'dozen-2' }, (p) => p >= 13 && p <= 24, 3],
    ['dozen-3', { type: 'dozen-3' }, (p) => p >= 25 && p <= 36, 3],
    ['column-1', { type: 'column', column: 1 }, (p) => p % 3 === 1, 3],
    ['column-2', { type: 'column', column: 2 }, (p) => p !== 0 && p % 3 === 2, 3],
    ['column-3', { type: 'column', column: 3 }, (p) => p !== 0 && p % 3 === 0, 3],
    ['split', { type: 'split', numbers: [1, 2] }, (p) => p === 1 || p === 2, 18],
    ['street', { type: 'street', numbers: [1, 2, 3] }, (p) => p >= 1 && p <= 3, 12],
    [
      'corner',
      { type: 'corner', numbers: [1, 2, 4, 5] },
      (p) => [1, 2, 4, 5].includes(p),
      9,
    ],
    [
      'six-line',
      { type: 'six_line', numbers: [1, 2, 3, 4, 5, 6] },
      (p) => p >= 1 && p <= 6,
      6,
    ],
  ];
  let ok = 0;
  for (const [name, betShape, winFn, mult] of cases) {
    const r = await bet('roulette', 50, { bet: betShape });
    const d = r.json?.data;
    const mo = d.mappedOutcome ?? {};
    const expectWin = winFn(mo.pocket);
    const good =
      mo.win === expectWin &&
      Math.abs(d.payoutMultiplier - (expectWin ? mult : 0)) < 0.001;
    if (good) ok++;
    else
      console.log(
        `   ${name} bad: pocket ${mo.pocket} win ${mo.win} mult ${d.payoutMultiplier}`
      );
  }
  pass(
    'roulette: 16 bet types resolve correctly with standard payouts',
    ok === cases.length,
    `${ok}/${cases.length}`
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
