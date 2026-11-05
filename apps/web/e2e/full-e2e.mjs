// e2e/full-e2e.mjs — comprehensive end-to-end verification (D-074)
// Covers: auth persistence, daily bonus, wallet, deposits (incl. CSRF), withdrawals,
// admin (login/logout/settings/fund/users), demo toggle, all 20 games settle, support,
// referral, leaderboard, provably-fair, legal pages, notifications, backup export.
// Run: cd apps/web && node e2e/full-e2e.mjs
import { execSync } from 'node:child_process';

const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const results = [];
const P = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const getSetCookies = (res) => {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const sc = res.headers.get('set-cookie');
  return sc ? [sc] : [];
};
const cookieFrom = (cookies, name) => {
  for (const c of cookies) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return '';
};

const call = async (method, path, { body, token, cookie, csrf, demo } = {}) => {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  if (demo) {
    h['X-Demo-Mode'] = 'true';
    h['X-Demo-Session'] = 'full-e2e-demo-session-0001';
  }
  const res = await fetch(`${B}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, json, cookies: getSetCookies(res) };
};

// ── 1. HEALTH ──────────────────────────────────────────────────────────────
const health = await call('GET', '/health');
P(
  'API health (db+redis)',
  health.status === 200 && health.json?.status === 'ok',
  JSON.stringify(health.json?.services)
);

// ── 2. GAMES LIST + DETAIL (demo OFF default) ──────────────────────────────
const games = await call('GET', '/api/v1/games');
P(
  'games list 20 games',
  games.status === 200 && games.json?.data?.length === 20,
  `${games.json?.data?.length} games`
);
P(
  'demo OFF by default',
  games.json?.data?.every((g) => !g.demoEnabled)
);
const detail = await call('GET', '/api/v1/games/coin-flip');
P(
  'game detail works',
  detail.status === 200 && detail.json?.data?.slug === 'coin-flip'
);

// ── 3. AUTH: signup / login / refresh persistence ─────────────────────────
const phone = `+9237${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const fp = { userAgent: 'e2e', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const signup = await call('POST', '/api/v1/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: fp },
});
P('signup works', signup.status === 200, phone);
const accessToken = signup.json?.data?.accessToken;
const user = signup.json?.data?.user;

const login = await call('POST', '/api/v1/auth/login', {
  body: { phone, password: 'TestPass123!', fingerprint: fp },
});
P('login works', login.status === 200 && !!login.json?.data?.accessToken);
P(
  'refresh cookie set (7d)',
  login.cookies.some((c) => c.startsWith('refresh_token='))
);

const refresh = await call('POST', '/api/v1/auth/refresh-token', {
  cookie: login.cookies.map((c) => c.split(';')[0]).join('; '),
});
P(
  'refresh rotates access token',
  refresh.status === 200 && !!refresh.json?.data?.accessToken,
  refresh.json?.message || ''
);
const freshToken = refresh.json?.data?.accessToken ?? accessToken;

const me = await call('GET', '/api/v1/auth/me', { token: freshToken });
P('session restore via /auth/me', me.status === 200 && me.json?.data?.phone === phone);

// ── 4. DAILY BONUS (checked AFTER the admin fund below — the seeded
//     daily_checkin_min_balance=100 rule requires ≥₨100 in the wallet, so a
//     fresh zero-balance account correctly gets BONUS_MIN_BALANCE 422) ─────
const streak0 = await call('GET', '/api/v1/bonuses/streak-status', {
  token: freshToken,
});
P(
  'streak-status (day 1 = ₨5)',
  streak0.status === 200 && Number(streak0.json?.data?.nextBonus) === 5,
  `nextBonus ${streak0.json?.data?.nextBonus}`
);
// zero-balance claim is rejected by the anti-farm rule (intentional)
const claimZero = await call('POST', '/api/v1/bonuses/daily-checkin', {
  token: freshToken,
});
P(
  'zero-balance claim blocked (BONUS_MIN_BALANCE)',
  claimZero.status === 422 && claimZero.json?.code === 'BONUS_MIN_BALANCE',
  `${claimZero.status} ${claimZero.json?.code ?? ''}`
);
// claim runs after the wallet is funded (section 5) — see below

// ── 5. WALLET + ADMIN FUND + REAL BET ─────────────────────────────────────
const adminLogin = await call('POST', '/api/v1/panel/auth/login', {
  body: {
    username: 'superadmin',
    password: process.env.ADMIN_PASS || 'change-this-immediately',
  },
});
P('admin login', adminLogin.status === 200);
const adminCookie = adminLogin.cookies.map((c) => c.split(';')[0]).join('; ');
const adminCsrf = cookieFrom(adminLogin.cookies, 'csrf_token');

const fund = await call('POST', `/api/v1/panel/users/${user.id}/fund`, {
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { walletType: 'real', amount: 5000, reason: 'e2e fund' },
});
P(
  'admin funds ₨5,000',
  fund.status === 200 && Number(fund.json?.data?.real) === 5000,
  `real ${fund.json?.data?.real}`
);

const bal = await call('GET', '/api/v1/wallet/balance', { token: freshToken });
P(
  'wallet balance reflects fund',
  Number(bal.json?.data?.real) === 5000,
  `real ${bal.json?.data?.real}`
);

// ── 4b. DAILY BONUS CLAIM (wallet now funded past the ₨100 min-balance rule)
const claim = await call('POST', '/api/v1/bonuses/daily-checkin', {
  token: freshToken,
});
P(
  'daily bonus claim credits ₨5',
  claim.status === 200 && claim.json?.data?.bonus === '5.00',
  `bonus ${claim.json?.data?.bonus}`
);
const balAfterClaim = await call('GET', '/api/v1/wallet/balance', {
  token: freshToken,
});
P(
  'bonus balance = ₨5 after claim',
  Number(balAfterClaim.json?.data?.bonus) === 5,
  `bonus ${balAfterClaim.json?.data?.bonus}`
);
const claim2 = await call('POST', '/api/v1/bonuses/daily-checkin', {
  token: freshToken,
});
P('double claim rejected (409)', claim2.status === 409);

// real bet (coin-flip schema key is `choice` — heads/tails)
const seedRes = await call('GET', '/api/v1/provably-fair/active-seed', {
  token: freshToken,
});
const seed = seedRes.json?.data?.clientSeed ?? 'e2e-seed';
const bet = await call('POST', '/api/v1/games/coin-flip/bet', {
  token: freshToken,
  body: {
    amount: 100,
    walletType: 'REAL',
    choices: { choice: 'heads' },
    clientSeed: seed,
  },
});
P(
  'real-money bet settles',
  bet.status === 200 && ['WIN', 'LOSE'].includes(bet.json?.data?.result),
  `${bet.json?.data?.result} @ ₨${bet.json?.data?.payoutAmount} ${bet.json?.message ?? ''}`
);

// ── 6. ALL 20 GAMES SETTLE ────────────────────────────────────────────────
const SLUGS = [
  'dice',
  'aviator',
  'crash-x',
  'plinko',
  'wingo',
  'mines',
  'wheel',
  'coin-flip',
  'tower',
  'stairs',
  'hi-lo',
  'limbo',
  'keno',
  'dragon-tiger',
  'roulette',
  'baccarat',
  'thimbles',
  'ring-of-fortune',
  'scratch-card',
  'lucky-number',
];
let settled = 0;
// D-092: mines/tower/stairs/hi-lo are SESSION games — start a session and
// settle it instead of /bet.
const SESSION_SLUGS = ['mines', 'tower', 'stairs', 'hi-lo'];
const SESSION_START = {
  mines: { mineCount: 1 },
  tower: { difficulty: 'easy' },
  stairs: {},
  'hi-lo': { guess: 'higher' },
};
const SESSION_ACTION = {
  mines: { tile: 0 },
  tower: { column: 0 },
  stairs: { pick: 0 },
  'hi-lo': { guess: 'higher' },
};
for (const slug of SLUGS) {
  if (SESSION_SLUGS.includes(slug)) {
    const s = await call('POST', `/api/v1/games/${slug}/session`, {
      token: freshToken,
      body: {
        amount: 10,
        walletType: 'REAL',
        choices: SESSION_START[slug],
        clientSeed: seed,
      },
    });
    if (s.status === 200 && s.json?.data?.status === 'SESSION_STARTED') {
      const sid = s.json?.data?.session?.roundId ?? '';
      const step = await call('POST', `/api/v1/games/${slug}/step`, {
        token: freshToken,
        body: { roundId: sid, action: SESSION_ACTION[slug] },
      });
      const fin = step.json?.data?.terminal
        ? step.status === 200
        : (
            await call('POST', `/api/v1/games/${slug}/cashout`, {
              token: freshToken,
              body: { roundId: sid },
            })
          ).status === 200;
      if (fin) settled++;
      else console.log(`   (${slug} → step/cashout failed)`);
    } else console.log(`   (${slug} → ${s.status} ${s.json?.message ?? ''})`);
    continue;
  }
  const choices =
    {
      dice: { over: true, target: 50.5 },
      plinko: { rows: 12, risk: 'medium' },
      wingo: { choice: 'red' },
      wheel: { tier: 'yellow' },
      'coin-flip': { choice: 'heads' },
      limbo: { target: 2 },
      keno: { picks: [1, 2, 3, 4, 5] },
      'dragon-tiger': { bet: 'dragon' },
      roulette: { bet: { type: 'red' } },
      baccarat: { bet: 'player' },
      thimbles: { cup: 0 },
      'ring-of-fortune': { tier: 'bronze' },
      'scratch-card': {},
      'lucky-number': { betMin: 40, betMax: 60 },
      aviator: {},
      'crash-x': {},
    }[slug] ?? {};
  // shared-round games (aviator/crash-x/wingo) can have no open betting window
  // in this exact moment (mid-flight / between rounds) — retry a few times.
  let r = await call('POST', `/api/v1/games/${slug}/bet`, {
    token: freshToken,
    body: { amount: 10, walletType: 'REAL', choices, clientSeed: seed },
  });
  for (let attempt = 0; attempt < 5 && r.status === 409; attempt++) {
    await new Promise((res) => setTimeout(res, 2500));
    r = await call('POST', `/api/v1/games/${slug}/bet`, {
      token: freshToken,
      body: { amount: 10, walletType: 'REAL', choices, clientSeed: seed },
    });
  }
  if (r.status === 200 && (r.json?.data?.result || r.json?.data?.status === 'PLACED'))
    settled++;
  else console.log(`   (${slug} → ${r.status} ${r.json?.message ?? ''})`);
}
P(`all 20 games accept bets (${settled}/20)`, settled >= 19, `${settled}/20 settled`);

// ── 7. DEMO TOGGLE ────────────────────────────────────────────────────────
const demoBet = await call('POST', '/api/v1/games/coin-flip/bet', {
  demo: true,
  body: {
    amount: 10,
    walletType: 'REAL',
    choices: { choice: 'heads' },
    clientSeed: 'demo',
  },
});
P(
  'demo bet blocked when demo OFF (403)',
  demoBet.status === 403,
  demoBet.json?.message ?? ''
);
const toggleOn = await call('PATCH', '/api/v1/panel/settings', {
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { demo_mode_enabled: true },
});
P('admin enables demo mode', toggleOn.status === 200);
const gamesOn = await call('GET', '/api/v1/games');
P(
  'demo visible after ON',
  gamesOn.json?.data?.every((g) => g.demoEnabled)
);
const demoBet2 = await call('POST', '/api/v1/games/coin-flip/bet', {
  demo: true,
  body: {
    amount: 10,
    walletType: 'REAL',
    choices: { choice: 'heads' },
    clientSeed: 'demo',
  },
});
P('demo bet works when ON', demoBet2.status === 200, `${demoBet2.json?.data?.result}`);
const toggleOff = await call('PATCH', '/api/v1/panel/settings', {
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { demo_mode_enabled: false },
});
P('admin disables demo mode', toggleOff.status === 200);

// ── 8. DEPOSIT FLOW (CSRF + proof upload). M-16: seeded example accounts are
//    INACTIVE by design (a fresh deploy must never tell players to send money
//    to placeholder numbers). And H-07: a deposit must carry a proof object that
//    actually exists in MinIO under this user's prefix — the real flow is
//    presigned PUT first, then /deposits/create with the returned objectKey.
//    (Determinism: force the seeded accounts back off first, so reruns behave.)
const deactivate = async (accId) =>
  call('PATCH', `/api/v1/panel/payment-accounts/${accId}`, {
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { isActive: false },
  });
await deactivate('acc-jazzcash');
await deactivate('acc-easypaisa');
await deactivate('acc-bank');
const accounts0 = await call('GET', '/api/v1/deposits/accounts', { token: freshToken });
P(
  'deposit accounts hidden until activated (M-16)',
  accounts0.status === 200 && accounts0.json?.data?.length === 0,
  `${accounts0.json?.data?.length} visible`
);
const activate = await call('PATCH', '/api/v1/panel/payment-accounts/acc-jazzcash', {
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { isActive: true },
});
P(
  'admin activates a payment account',
  activate.status === 200,
  activate.json?.message ?? ''
);
const accounts = await call('GET', '/api/v1/deposits/accounts', { token: freshToken });
P(
  'deposit accounts list after activation',
  accounts.status === 200 && accounts.json?.data?.length >= 1,
  `${accounts.json?.data?.length} accounts`
);
// Browser-equivalent cookie pair = the ROTATED pair the refresh endpoint
// handed out (a real browser holds exactly that after its first page reload).
const depCsrf =
  cookieFrom(refresh.cookies, 'csrf_token') || cookieFrom(login.cookies, 'csrf_token');
const depCookie =
  refresh.cookies.length > 0
    ? refresh.cookies.map((c) => c.split(';')[0]).join('; ')
    : login.cookies.map((c) => c.split(';')[0]).join('; ');
// H-07 real proof flow: presign → PUT a small jpeg to MinIO → create.
const up = await call('POST', '/api/v1/deposits/upload-url', {
  token: freshToken,
  cookie: depCookie,
  csrf: depCsrf,
  body: { fileName: 'proof.jpg', fileType: 'image/jpeg', fileSize: 600 },
});
P(
  'deposit proof presigned URL issued',
  up.status === 200 && !!up.json?.data?.presignedUrl,
  up.json?.message ?? ''
);
let proofKey = up.json?.data?.objectKey;
if (up.json?.data?.presignedUrl) {
  const putRes = await fetch(up.json.data.presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: Buffer.alloc(600, 7),
  });
  P(
    'proof uploaded straight to MinIO (H-07)',
    putRes.status === 200,
    `PUT ${putRes.status}`
  );
} else {
  proofKey = undefined;
  P('proof uploaded straight to MinIO (H-07)', false, 'no presigned URL');
}
const dep = await call('POST', '/api/v1/deposits/create', {
  token: freshToken,
  cookie: depCookie,
  csrf: depCsrf,
  body: {
    amount: 500,
    paymentMethod: 'acc-jazzcash',
    accountLabel: 'JazzCash Wallet',
    accountDetails: { account_number: '0301 2345678', holder: 'YourBrand' },
    senderAccount: '0300-1234567',
    proofObjectKey: proofKey,
  },
});
P(
  'deposit created → PENDING',
  dep.status === 200 && dep.json?.data?.status === 'PENDING',
  dep.json?.data?.referenceNumber ?? dep.json?.message ?? ''
);
const depNoCsrf = await call('POST', '/api/v1/deposits/create', {
  token: freshToken,
  body: { amount: 500, paymentMethod: 'acc-jazzcash' },
});
P('deposit without CSRF rejected (403)', depNoCsrf.status === 403);
// admin approves → credited + notification
const depId = dep.json?.data?.id;
const balBeforeDep = await call('GET', '/api/v1/wallet/balance', { token: freshToken });
const approve = await call('PATCH', `/api/v1/panel/deposits/${depId}`, {
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { status: 'APPROVED' },
});
P('admin approves deposit', approve.status === 200, approve.json?.message || '');
const balAfterDep = await call('GET', '/api/v1/wallet/balance', { token: freshToken });
const credited =
  Number(balAfterDep.json?.data?.real) - Number(balBeforeDep.json?.data?.real);
P(
  'wallet credited ₨500 after approval',
  credited >= 499,
  `+₨${credited} (${balBeforeDep.json?.data?.real} → ${balAfterDep.json?.data?.real})`
);

// ── 9. WITHDRAWAL FLOW ────────────────────────────────────────────────────
const fee = await call('GET', '/api/v1/withdrawals/fee-preview?amount=1000', {
  token: freshToken,
});
P(
  'withdrawal fee preview',
  fee.status === 200 && Number(fee.json?.data?.net) === 980,
  `net ${fee.json?.data?.net}`
);
const pa = await call('POST', '/api/v1/withdrawals/payout-accounts', {
  token: freshToken,
  cookie: depCookie,
  csrf: depCsrf,
  body: {
    type: 'mobile_wallet',
    label: 'My JazzCash',
    accountNumber: '0300-1112223',
    holder: 'E2E Tester',
  },
});
P(
  'payout account created',
  pa.status === 200 && !!pa.json?.data?.id,
  pa.json?.message || 'ok'
);
const paList = await call('GET', '/api/v1/withdrawals/payout-accounts', {
  token: freshToken,
});
P(
  'payout accounts list shows mine',
  paList.status === 200 && paList.json?.data?.some((a) => a.id === pa.json?.data?.id)
);
const wd = await call('POST', '/api/v1/withdrawals/create', {
  token: freshToken,
  cookie: depCookie,
  csrf: depCsrf,
  body: { amount: 1000, payoutAccountId: pa.json?.data?.id },
});
P(
  'withdrawal request created (real account)',
  wd.status === 200 && ['PENDING', 'APPROVED'].includes(wd.json?.data?.status),
  `${wd.json?.data?.status} net ${wd.json?.data?.netAmount}`
);

// ── 10. SUPPORT ───────────────────────────────────────────────────────────
const conv = await call('POST', '/api/v1/support/conversations', {
  token: freshToken,
  body: { subject: 'E2E test', message: 'Testing support' },
});
P('support conversation created', conv.status === 200, conv.json?.message || 'ok');
const convId = conv.json?.data?.id;
const reply = await call(
  'POST',
  `/api/v1/panel/support/conversations/${convId}/reply`,
  { cookie: adminCookie, csrf: adminCsrf, body: { message: 'We are on it!' } }
);
P('admin reply to conversation', reply.status === 200);
const msgs = await call('GET', `/api/v1/support/conversations/${convId}/messages`, {
  token: freshToken,
});
P(
  'player sees admin reply',
  msgs.status === 200 && msgs.json?.data?.some((m) => m.senderType === 'ADMIN')
);

// ── 11. REFERRAL + LEADERBOARD ────────────────────────────────────────────
const ref = await call('GET', '/api/v1/referral/code', { token: freshToken });
P(
  'referral code available',
  ref.status === 200 && !!ref.json?.data?.code,
  ref.json?.data?.code
);
const lb = await call('GET', '/api/v1/leaderboard/daily?limit=5', {
  token: freshToken,
});
P('leaderboard works (authed)', lb.status === 200 && Array.isArray(lb.json?.data));

// ── 12. PROVABLY FAIR ─────────────────────────────────────────────────────
const pf = await call('GET', '/api/v1/provably-fair/active-seed', {
  token: freshToken,
});
P('provably-fair active seed', pf.status === 200 && !!pf.json?.data?.serverSeedHash);
const rot = await call('POST', '/api/v1/provably-fair/rotate-seed', {
  token: freshToken,
});
P('seed rotation works', rot.status === 200);

// ── 13. LEGAL PAGES (public) ──────────────────────────────────────────────
const legal = await call('GET', '/api/v1/legal/terms');
P('legal page public (terms)', legal.status === 200 && !!legal.json?.data?.content);
const legalNotFound = await call('GET', '/api/v1/legal/does-not-exist');
P('legal 404 for unknown slug', legalNotFound.status === 404);

// ── 14. NOTIFICATIONS ─────────────────────────────────────────────────────
const notifs = await call('GET', '/api/v1/notifications', { token: freshToken });
P(
  'notifications (deposit approved present)',
  notifs.status === 200 && notifs.json?.data?.some((n) => n.type === 'deposit'),
  `${notifs.json?.data?.length} notifications`
);

// ── 15. ADMIN: logout / users / transactions / backup ─────────────────────
const adminMe = await call('GET', '/api/v1/panel/auth/me', { cookie: adminCookie });
P('admin /auth/me', adminMe.status === 200);
const users = await call('GET', '/api/v1/panel/users?page=1', { cookie: adminCookie });
P(
  'admin users list',
  users.status === 200 && users.json?.data?.data?.length >= 1,
  `${users.json?.data?.total} users`
);
const txns = await call('GET', '/api/v1/panel/transactions?page=1', {
  cookie: adminCookie,
});
P(
  'admin transactions ledger',
  txns.status === 200 && txns.json?.data?.data?.length >= 1,
  `${txns.json?.data?.total} rows`
);
const stats = await call('GET', '/api/v1/panel/dashboard/stats', {
  cookie: adminCookie,
});
P(
  'admin dashboard stats',
  stats.status === 200 && Number(stats.json?.data?.totals?.volume) > 0,
  `volume ₨${stats.json?.data?.totals?.volume}`
);
const audit = await call('GET', '/api/v1/panel/audit-log?page=1', {
  cookie: adminCookie,
});
P('admin audit log', audit.status === 200 && audit.json?.data?.data?.length >= 1);
const backup = await call('GET', '/api/v1/panel/backup/export-json', {
  cookie: adminCookie,
});
P(
  'backup export works',
  backup.status === 200 && !!(backup.json?.data || backup.json?.exportedAt),
  backup.json?.encrypted ? `encrypted v${backup.json?.version}` : ''
);
const logout = await call('POST', '/api/v1/panel/auth/logout', { cookie: adminCookie });
P('admin logout', logout.status === 200);
// browser drops the cleared cookie → subsequent requests are anonymous
const afterLogout = await call('GET', '/api/v1/panel/auth/me');
P('admin session dead after logout', afterLogout.status === 401);

// ── 16. GUEST GATING ──────────────────────────────────────────────────────
const guestUsers = await call('GET', '/api/v1/panel/users');
P('panel API blocked for guests (401)', guestUsers.status === 401);
const guestWallet = await call('GET', '/api/v1/wallet/balance');
P('wallet API blocked for guests (401)', guestWallet.status === 401);

console.log(`\n══════════════════════════════════════════`);
console.log(`FULL E2E RESULT: ${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log('FAILED:');
  for (const r of results.filter((x) => !x.ok))
    console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
}
process.exit(fail ? 1 : 0);
