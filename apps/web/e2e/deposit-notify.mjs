// e2e/deposit-notify.mjs — D-083: admin approves a deposit → the USER's socket
// receives `notification:new` AND `deposit:status` in real time (verifies the
// user:{id} room join fix). Also verifies balance credit.
import { io } from 'socket.io-client';
const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// user signs up (any phone format!) + socket connects
const fp = { userAgent: 'e2e-dn', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const signup = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const sj = await signup.json();
const token = sj.data.accessToken;
const uid = sj.data.user.id;
const cookies = (signup.headers.getSetCookie ? signup.headers.getSetCookie() : [])
  .map((c) => c.split(';')[0])
  .join('; ');
const csrf =
  (signup.headers.getSetCookie ? signup.headers.getSetCookie() : [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1]
    .split(';')[0] ?? '';

const sock = io(B, { auth: { token }, transports: ['websocket'], reconnection: false });
const events = [];
sock.on('notification:new', (n) => events.push(['notification', n.type, n.title]));
sock.on('deposit:status', (s2) =>
  events.push(['deposit:status', s2.status, String(s2.amount)])
);
await sleep(700);

// user creates deposit with a REAL uploaded proof (H-07 hardening: the
// proof object must exist under the user's own prefix or create is rejected)
const pngBuf = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000525cf00000000a49444154789c626001000000ffff030000060005' +
    '57bfabd40000000049454e44ae426082',
  'hex'
);
const upForm = new FormData();
upForm.append('file', new Blob([pngBuf], { type: 'image/png' }), 'proof.png');
const up = await fetch(`${B}/api/v1/deposits/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Cookie: cookies, 'X-CSRF-Token': csrf },
  body: upForm,
});
const proofKey = (await up.json()).data?.objectKey;
const dep = await fetch(`${B}/api/v1/deposits/create`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Cookie: cookies,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    amount: 750,
    proofObjectKey: proofKey,
    paymentMethod: 'acc-jazzcash',
    accountLabel: 'JazzCash',
    accountDetails: { account_number: '0300-111' },
    senderAccount: '0300-222',
  }),
});
const depId = (await dep.json()).data?.id;
P('deposit created', dep.status === 200 && !!depId, depId ?? '');

// admin approves
const adminLogin = await fetch(`${B}/api/v1/panel/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'superadmin', password: 'change-this-immediately' }),
});
const ac = (adminLogin.headers.getSetCookie ? adminLogin.headers.getSetCookie() : [])
  .map((c) => c.split(';')[0])
  .join('; ');
const acs =
  (adminLogin.headers.getSetCookie ? adminLogin.headers.getSetCookie() : [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1]
    .split(';')[0] ?? '';
const approve = await fetch(`${B}/api/v1/panel/deposits/${depId}`, {
  method: 'PATCH',
  headers: { Cookie: ac, 'X-CSRF-Token': acs, 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'APPROVED' }),
});
P('admin approves', approve.status === 200);

await sleep(1200);
P(
  'user received deposit:status via socket',
  events.some((e) => e[0] === 'deposit:status' && e[1] === 'APPROVED')
);
P(
  'user received notification:new via socket',
  events.some(
    (e) => e[0] === 'notification' && e[1] === 'deposit' && e[2].includes('approved')
  )
);
const bal = await fetch(`${B}/api/v1/wallet/balance`, {
  headers: { Authorization: `Bearer ${token}` },
});
const balJ = await bal.json();
P('balance credited ₨750', Number(balJ.data?.real) >= 749, `real ${balJ.data?.real}`);
sock.close();

console.log(`\nDEPOSIT NOTIFY: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
