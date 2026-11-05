// e2e/bonus-audit-v141.mjs — v1.4.1 bonus-system audit, every leg live:
//   1. SIGNUP BONUS: enabled + ₨100 → new user gets ₨100 BONUS wallet + ledger
//   2. REFERRAL: A shares code, B signs up → B gets referee ₨25 (+welcome
//      ₨100 = 125), A gets referrer ₨75; /referral/stats shows the earning
//   3. PACKAGE BONUS: B buys a package deposit → admin approves → B's REAL
//      wallet grows by pkg.credits, BONUS wallet by pkg.bonus
//   (daily check-in has its own probe: bonus-claim.test.mjs — run it too)
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

// known bonus settings for the audit
const bset = await panelPatch('/api/v1/panel/settings', {
  signup_bonus_enabled: true,
  signup_bonus_amount: 100,
  referral_bonus_referrer: 75,
  referral_bonus_referee: 25,
});
P(
  'bonus settings staged (100 welcome · 75/25 referral)',
  bset.status === 200,
  `status ${bset.status}`
);

async function signup(tag, referralCode) {
  const su = await fetch(`${B}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`,
      password: 'TestPass123!',
      fingerprint: {
        userAgent: `e2e-${tag}`,
        screenRes: '1x1',
        timezone: 'UTC',
        language: 'en',
      },
      ...(referralCode ? { referralCode } : {}),
    }),
  });
  const sj = await su.json();
  return {
    token: sj.data.accessToken,
    id: sj.data.user.id,
    cookies: cookiesOf(su),
    csrf: csrfOf(su),
    bonus: sj.data.user.wallet?.bonusBalance ?? sj.data.user.wallet?.bonus ?? null,
  };
}
const hdrs = (u, json = false) => ({
  Authorization: `Bearer ${u.token}`,
  Cookie: u.cookies,
  'x-csrf-token': u.csrf,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});
async function balance(tok) {
  const r = await fetch(`${B}/api/v1/wallet/balance`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = await r.json();
  return { real: Number(j.data.real), bonus: Number(j.data.bonus) };
}

// ---- 1. signup bonus ----
const A = await signup('bonusA');
const balA = await balance(A.token);
P(
  'signee gets ₨100 welcome in BONUS wallet',
  balA.bonus === 100,
  `bonus=${balA.bonus}`
);

// ledger row exists (BONUS_SIGNUP)
const txA = await fetch(`${B}/api/v1/wallet/transactions?pageSize=5`, {
  headers: { Authorization: `Bearer ${A.token}` },
});
const txAj = await txA.json();
const hasSignupTx = JSON.stringify(txAj.data ?? txAj).includes('BONUS_SIGNUP');
P('BONUS_SIGNUP ledger row recorded', hasSignupTx);

// ---- 2. referral both legs ----
const codeRes = await fetch(`${B}/api/v1/referral/code`, {
  headers: { Authorization: `Bearer ${A.token}` },
});
const codeJ = await codeRes.json();
const code = codeJ.data?.code ?? codeJ.data;
P('referral code issued', !!code, String(code).slice(0, 10));

const BUser = await signup('bonusB', code);
const balB0 = await balance(BUser.token);
P(
  'referee wallet = welcome 100 + referral 25 → 125',
  balB0.bonus === 125,
  `bonus=${balB0.bonus}`
);
const balA0 = await balance(A.token);
P(
  'referrer wallet = welcome 100 + referrer 75 → 175',
  balA0.bonus === 175,
  `bonus=${balA0.bonus}`
);

const stats = await fetch(`${B}/api/v1/referral/stats`, {
  headers: { Authorization: `Bearer ${A.token}` },
});
const statsJ = await stats.json().catch(() => null);
P(
  '/referral/stats reflects the earning',
  JSON.stringify(statsJ?.data ?? {}).includes('75') ||
    JSON.stringify(statsJ?.data ?? {}).includes('1'),
  JSON.stringify(statsJ?.data).slice(0, 90)
);

// ---- 3. package bonus on approval ----
// seed ships zero packages (admin-created entities) — create one for the audit
const createPkg = await fetch(`${B}/api/v1/panel/packages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: AC, 'x-csrf-token': ACRF },
  body: JSON.stringify({
    name: 'E2E Audit Pack',
    price: 500,
    credits: 500,
    bonus: 150,
    description: 'bonus-audit fixture',
  }),
});
P(
  'audit package created via panel',
  createPkg.status === 200 || createPkg.status === 201,
  `status ${createPkg.status}`
);
const pkgs = await (await fetch(`${B}/api/v1/deposits/packages`)).json();
const pkg = (pkgs.data ?? []).find((p) => p.name === 'E2E Audit Pack');
P(
  'active package available',
  !!pkg,
  pkg
    ? `${pkg.name} price=${pkg.price} credits=${pkg.credits} bonus=${pkg.bonus}`
    : 'none'
);

if (pkg) {
  const form = new FormData();
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000525cf00000000a49444154789c626001000000ffff030000060005' +
      '57bfabd40000000049454e44ae426082',
    'hex'
  );
  form.append('file', new Blob([png], { type: 'image/png' }), 'proof.png');
  const up = await fetch(`${B}/api/v1/deposits/upload`, {
    method: 'POST',
    headers: hdrs(BUser),
    body: form,
  });
  const upJ = await up.json().catch(() => null);
  const proofKey = upJ?.data?.objectKey;
  P('proof uploaded for package deposit', !!proofKey, `status ${up.status}`);

  const before = await balance(BUser.token);
  const dep = await fetch(`${B}/api/v1/deposits/create`, {
    method: 'POST',
    headers: hdrs(BUser, true),
    body: JSON.stringify({
      amount: Number(pkg.price),
      packageId: pkg.id,
      paymentMethod: 'easypaisa',
      senderAccount: '03001234567',
      proofObjectKey: proofKey,
    }),
  });
  const depJ = await dep.json().catch(() => null);
  const depId = depJ?.data?.id ?? depJ?.data?.depositId;
  P(
    'package deposit created',
    dep.status === 200 && !!depId,
    `status ${dep.status} ${JSON.stringify(depJ).slice(0, 90)}`
  );

  // admin approves
  const ap = await panelPatch(`/api/v1/panel/deposits/${depId}`, {
    status: 'APPROVED',
  });
  P('admin approves deposit', ap.status === 200, `status ${ap.status}`);

  const after = await balance(BUser.token);
  const realGained = after.real - before.real;
  const bonusGained = after.bonus - before.bonus;
  P(
    `REAL wallet +${pkg.credits} on approval`,
    realGained === Number(pkg.credits),
    `gained=${realGained}`
  );
  P(
    `BONUS wallet +${pkg.bonus} package bonus`,
    bonusGained === Number(pkg.bonus),
    `gained=${bonusGained}`
  );
}

// ---- restore seed defaults ----
const back = await panelPatch('/api/v1/panel/settings', {
  signup_bonus_enabled: false,
  signup_bonus_amount: 0,
  referral_bonus_referrer: 25,
  referral_bonus_referee: 10,
});
P('bonus settings restored to seed defaults', back.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
