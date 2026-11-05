// e2e/bonus-claim.test.mjs — D-080 regression: the daily bonus claim (and other
// body-less POSTs) must NOT send Content-Type: application/json with an empty
// body (Fastify rejects it: "Body cannot be empty when content-type is set to
// 'application/json'"). This test mimics the fixed client behavior.
const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};

const fp = { userAgent: 'e2e-bc', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const phone = `+9230${String(40000000 + Math.floor(Math.random() * 49999999))}`;
const signup = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const signupData = (await signup.json()).data;
const token = signupData.accessToken;
// Daily rewards require a minimum playable balance. Fund through the same
// audited admin path production uses so this test reaches the body-less POST.
const admin = await fetch(`${B}/api/v1/panel/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USER || 'superadmin',
    password: process.env.ADMIN_PASS || 'change-this-immediately',
  }),
});
const cookies =
  admin.headers.getSetCookie?.().map((value) => value.split(';')[0]) ?? [];
const csrf =
  cookies.find((value) => value.startsWith('csrf_token='))?.split('=')[1] ?? '';
await fetch(`${B}/api/v1/panel/users/${signupData.user.id}/fund`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookies.join('; '),
    'x-csrf-token': csrf,
  },
  body: JSON.stringify({
    walletType: 'real',
    amount: 100,
    reason: 'bonus E2E eligibility',
  }),
});

// EXACTLY like the fixed api.ts: no Content-Type header when body is undefined
const claim = await fetch(`${B}/api/v1/bonuses/daily-checkin`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const claimJson = await claim.json();
P(
  'daily bonus claim works (no Content-Type, no body)',
  claim.status === 200 && claimJson.data?.bonus === '5.00',
  `bonus ${claimJson.data?.bonus}`
);

const bal = await fetch(`${B}/api/v1/wallet/balance`, {
  headers: { Authorization: `Bearer ${token}` },
});
const balJson = await bal.json();
P(
  'bonus credited to balance',
  Number(balJson.data?.bonus) === 5,
  `bonus ${balJson.data?.bonus}`
);

const rotate = await fetch(`${B}/api/v1/provably-fair/rotate-seed`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
P('seed rotation works (body-less POST)', rotate.status === 200);

const readAll = await fetch(`${B}/api/v1/notifications/read-all`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
P('notifications read-all works (body-less POST)', readAll.status === 200);

// OLD broken behavior reproduced for documentation (header + empty body → 400)
const broken = await fetch(`${B}/api/v1/bonuses/daily-checkin`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
});
const brokenBody = await broken.json().catch(() => ({}));
P(
  'double-claim rejected (2nd POST, CT + empty body → 409)',
  broken.status === 409,
  `status ${broken.status} ${JSON.stringify(brokenBody)}`
);

console.log(`\nBONUS CLAIM: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
