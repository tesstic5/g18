// e2e/money-limits-v141.mjs — v1.4.1 live verification of admin-set min/max
// deposit & withdrawal bounds:
//   1. public GET /wallet/limits mirrors admin settings INSTANTLY
//   2. deposit below min → 422; above max → 422; inside → 200
//   3. withdrawal below min → FIN_002; above max → FIN_008; inside → 200
//   4. settings PATCH refuses an inverted min>max window (merge-aware)
//   5. defaults restored afterwards
import { execSync } from 'child_process';

const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};
const cookiesOf = (r) =>
  (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const csrfOf = (r) =>
  (r.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split(';')[0]
    ?.split('=')[1] ?? '';

// ---------- sessions ----------
const al = await fetch(`${B}/api/v1/panel/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'superadmin', password: 'change-this-immediately' }),
});
const AC = cookiesOf(al),
  ACRF = csrfOf(al);
P('admin login', al.status === 200);

async function panelPatch(path, body) {
  const r = await fetch(`${B}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: AC, 'x-csrf-token': ACRF },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

const su = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    phone: `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`,
    password: 'TestPass123!',
    fingerprint: {
      userAgent: 'e2e-v141',
      screenRes: '1x1',
      timezone: 'UTC',
      language: 'en',
    },
  }),
});
const sj = await su.json();
const P_T = sj.data.accessToken,
  U = sj.data.user.id;
const PC = cookiesOf(su),
  PCRF = csrfOf(su);
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=20000 WHERE \\"userId\\"='${U}'"`,
  { stdio: 'pipe' }
);
P('player session funded', !!P_T);
const PH = () => ({ Authorization: `Bearer ${P_T}`, Cookie: PC, 'x-csrf-token': PCRF });
const PJ = () => ({ ...PH(), 'Content-Type': 'application/json' });

// ---------- limits endpoint mirrors settings ----------
const set = await panelPatch('/api/v1/panel/settings', {
  min_deposit: 200,
  max_deposit: 1000,
  min_withdrawal: 300,
  max_withdrawal: 2000,
});
P('admin sets min/max windows', set.status === 200, `status ${set.status}`);
const limits = await (await fetch(`${B}/api/v1/wallet/limits`)).json();
P(
  'GET /wallet/limits mirrors instantly (public)',
  limits.data?.minDeposit === 200 &&
    limits.data?.maxDeposit === 1000 &&
    limits.data?.minWithdrawal === 300 &&
    limits.data?.maxWithdrawal === 2000,
  JSON.stringify(limits.data)
);

// ---------- deposit bounds ----------
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000525cf00000000a49444154789c626001000000ffff030000060005' +
    '57bfabd40000000049454e44ae426082',
  'hex'
);
async function freshProof() {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'proof.png');
  const r = await fetch(`${B}/api/v1/deposits/upload`, {
    method: 'POST',
    headers: PH(),
    body: form,
  });
  return (await r.json())?.data?.objectKey;
}
async function deposit(amount) {
  const r = await fetch(`${B}/api/v1/deposits/create`, {
    method: 'POST',
    headers: PJ(),
    body: JSON.stringify({
      amount,
      paymentMethod: 'easypaisa',
      senderAccount: '0300',
      proofObjectKey: await freshProof(),
    }),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

// NOTE: deposit rate pacing — defaults are 5/hour, plenty for this probe
const dLo = await deposit(150);
P(
  'deposit ₨150 below min 200 → 422',
  dLo.status === 422 && /Minimum deposit/i.test(dLo.json?.message ?? ''),
  `status ${dLo.status} msg=${(dLo.json?.message ?? '').slice(0, 50)}`
);
const dHi = await deposit(1500);
P(
  'deposit ₨1500 above max 1000 → 422',
  dHi.status === 422 && /Maximum deposit/i.test(dHi.json?.message ?? ''),
  `status ${dHi.status} msg=${(dHi.json?.message ?? '').slice(0, 50)}`
);
const dOk = await deposit(500);
P('deposit ₨500 inside window → 200', dOk.status === 200, `status ${dOk.status}`);

// ---------- withdrawal bounds ----------
const pa = await fetch(`${B}/api/v1/withdrawals/payout-accounts`, {
  method: 'POST',
  headers: PJ(),
  body: JSON.stringify({
    type: 'mobile_wallet',
    label: 'E2E',
    accountNumber: '03007654321',
    holder: 'T',
  }),
});
const paId = (await pa.json())?.data?.id;
async function withdraw(amount) {
  const r = await fetch(`${B}/api/v1/withdrawals/create`, {
    method: 'POST',
    headers: PJ(),
    body: JSON.stringify({ amount, payoutAccountId: paId }),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}
const wLo = await withdraw(200);
P(
  'withdrawal ₨200 below min 300 → FIN_002',
  wLo.status === 422 && wLo.json?.code === 'FIN_002',
  `status ${wLo.status} code=${wLo.json?.code}`
);
const wHi = await withdraw(5000);
P(
  'withdrawal ₨5000 above max 2000 → FIN_008',
  wHi.status === 422 && wHi.json?.code === 'FIN_008',
  `status ${wHi.status} code=${wHi.json?.code} msg=${(wHi.json?.message ?? '').slice(0, 40)}`
);
const wOk = await withdraw(1000);
P('withdrawal ₨1000 inside window → 200', wOk.status === 200, `status ${wOk.status}`);

// ---------- inversion guard ----------
const bad = await panelPatch('/api/v1/panel/settings', { min_deposit: 5000 });
P(
  'min>max inversion REFUSED (5000 > 1000)',
  bad.status === 422 && /cannot be greater/i.test(bad.json?.message ?? ''),
  `status ${bad.status}`
);
const bad2 = await panelPatch('/api/v1/panel/settings', { max_withdrawal: 100 });
P(
  'max<min inversion REFUSED (100 < 300)',
  bad2.status === 422,
  `status ${bad2.status}`
);
const afterBad = await (await fetch(`${B}/api/v1/wallet/limits`)).json();
P(
  'settings unchanged after refused patches',
  afterBad.data?.minDeposit === 200 && afterBad.data?.maxWithdrawal === 2000
);

// ---------- restore ----------
const restore = await panelPatch('/api/v1/panel/settings', {
  min_deposit: 10,
  max_deposit: 100000,
  min_withdrawal: 500,
  max_withdrawal: 100000,
});
P('defaults restored (10/100k · 500/100k)', restore.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
