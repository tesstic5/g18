// e2e/admin-notify-live.mjs — v1.3.8 live verification of the admin
// notification pipeline (the fix: SocketServer now registers globalThis.__io,
// which was previously only set by tests, so EVERY emitAdmin() silently
// no-oped in production).
//
//   1. admin logs in → ws-token → socket joined to 'admins' room
//   2. player signs up                    ⇒ expect admin:new-signup
//   3. player submits a DEPOSIT request   ⇒ expect admin:new-deposit  (amount)
//   4. player submits WITHDRAWAL request  ⇒ expect admin:withdrawal-request (netAmount)
//   5. events rejected with wrong/empty amounts would fail the asserts
import { io } from 'socket.io-client';
import { execSync } from 'child_process';

const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------
const mkCookies = (res) => {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).join('; ');
};
const csrfOf = (res) =>
  (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split(';')[0]
    ?.split('=')[1] ?? '';

async function call(method, path, { token, cookies, body, csrf } = {}) {
  const headers = {};
  if (body !== undefined && typeof body === 'object')
    headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (cookies) headers['Cookie'] = cookies;
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${B}${path}`, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, cookies: mkCookies(res), csrf: csrfOf(res) };
}

// wait-for-event with timeout
function expectEvent(sock, name, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ got: false, payload: null }), timeoutMs);
    sock.once(name, (p) => {
      clearTimeout(t);
      resolve({ got: true, payload: p });
    });
  });
}

// ---------- 1. admin side ----------
const login = await call('POST', '/api/v1/panel/auth/login', {
  body: { username: 'superadmin', password: 'change-this-immediately' },
});
P('admin login', login.status === 200, `status ${login.status}`);
const adminCookies = login.cookies;
const adminCsrf = login.csrf;

const tok = await call('GET', '/api/v1/panel/auth/ws-token', {
  cookies: adminCookies,
});
const wsToken = tok.json?.data?.token ?? tok.json?.token;
P('admin ws-token issued', !!wsToken);

const adminSock = io(B, { auth: { token: wsToken }, transports: ['websocket'] });
const connected = await new Promise((res) => {
  adminSock.on('connect', () => res(true));
  adminSock.on('connect_error', (e) => res(`err: ${e.message}`));
  setTimeout(() => res('timeout'), 8000);
});
P('admin socket connected (joined admins room)', connected === true, `${connected}`);

// ---------- 2. player signup ⇒ admin:new-signup ----------
const evSignup = expectEvent(adminSock, 'admin:new-signup');
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const fp = {
  userAgent: 'e2e-adminnotif',
  screenRes: '1x1',
  timezone: 'UTC',
  language: 'en',
};
const su = await call('POST', '/api/v1/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: fp },
});
P('player signup', su.status === 200 || su.status === 201, `status ${su.status}`);
const userToken = su.json?.data?.accessToken;
const userId = su.json?.data?.user?.id;
const userCookies = su.cookies;
const userCsrf = su.csrf;

const signupGot = await evSignup;
P(
  'admin:new-signup received',
  signupGot.got,
  signupGot.got ? JSON.stringify(signupGot.payload).slice(0, 80) : 'TIMEOUT'
);

// ---------- 3. deposit request ⇒ admin:new-deposit ----------
// fund the wallet first (rig shortcut) so a later withdrawal also clears
if (userId) {
  execSync(
    `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=20000 WHERE \\"userId\\"='${userId}'"`,
    { stdio: 'pipe' }
  );
}

// upload a proof via the multipart relay (real path; presign needs a public host)
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000525cf00000000a49444154789c626001000000ffff030000060005' +
    '57bfabd40000000049454e44ae426082',
  'hex'
);
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'proof.png');
const upRes = await fetch(`${B}/api/v1/deposits/upload`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${userToken}`,
    Cookie: userCookies,
    'x-csrf-token': userCsrf,
  },
  body: form,
});
const upJson = await upRes.json().catch(() => null);
const objectKey = upJson?.data?.objectKey ?? upJson?.objectKey;
P('proof uploaded via relay', !!objectKey, objectKey ?? `status ${upRes.status}`);

const evDeposit = expectEvent(adminSock, 'admin:new-deposit');
const dep = await call('POST', '/api/v1/deposits/create', {
  token: userToken,
  cookies: userCookies,
  csrf: userCsrf,
  body: {
    amount: 1500,
    paymentMethod: 'easypaisa',
    accountLabel: 'E2E account',
    senderAccount: '03001234567',
    proofObjectKey: objectKey,
  },
});
P(
  'deposit request created',
  dep.status === 200 || dep.status === 201,
  `status ${dep.status}`
);

const depGot = await evDeposit;
P(
  'admin:new-deposit received',
  depGot.got && Number(depGot.payload?.amount) === 1500,
  depGot.got
    ? `amount=${depGot.payload?.amount} method=${depGot.payload?.method}`
    : 'TIMEOUT'
);

// ---------- 4. withdrawal request ⇒ admin:withdrawal-request ----------
const pa = await call('POST', '/api/v1/withdrawals/payout-accounts', {
  token: userToken,
  cookies: userCookies,
  csrf: userCsrf,
  body: {
    type: 'mobile_wallet',
    label: 'JazzCash E2E',
    accountNumber: '03007654321',
    holder: 'E2E Tester',
  },
});
const paId = pa.json?.data?.id ?? pa.json?.data?.account?.id ?? pa.json?.id;
P('payout account created', !!paId, `status ${pa.status}`);

const evWd = expectEvent(adminSock, 'admin:withdrawal-request');
const wd = await call('POST', '/api/v1/withdrawals/create', {
  token: userToken,
  cookies: userCookies,
  csrf: userCsrf,
  body: { amount: 5000, payoutAccountId: paId },
});
P(
  'withdrawal request created',
  wd.status === 200 || wd.status === 201,
  `status ${wd.status} ${wd.status >= 400 ? JSON.stringify(wd.json).slice(0, 120) : ''}`
);

const wdGot = await evWd;
P(
  'admin:withdrawal-request received',
  wdGot.got && Number(wdGot.payload?.amount) === 5000,
  wdGot.got
    ? `amount=${wdGot.payload?.amount} net=${wdGot.payload?.netAmount}`
    : 'TIMEOUT'
);

adminSock.disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
