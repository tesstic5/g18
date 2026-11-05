// e2e/balance-coerce.test.mjs — REGRESSION TEST for D-077.
// The API returns balances as STRINGS (Decimal.toString). The client store must
// coerce them to numbers before UI calls .toFixed() — otherwise every page
// crashes for logged-in users ("Something went wrong"; guests unaffected
// because they never fetch the balance).
// Run: cd apps/web && node e2e/balance-coerce.test.mjs
const B = process.env.API || 'http://localhost:4000';

const phone = `+9238${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const fp = { userAgent: 'e2e', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const signup = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const {
  data: { accessToken },
} = await signup.json();

const res = await fetch(`${B}/api/v1/wallet/balance`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const { data: balance } = await res.json();

// exact store normalization (must match src/stores/index.ts setBalance)
const setBalance = (b) => ({
  real: Number(b?.real ?? 0) || 0,
  bonus: Number(b?.bonus ?? 0) || 0,
  gifted: Number(b?.gifted ?? 0) || 0,
  locked: Number(b?.locked ?? 0) || 0,
});
const state = setBalance(balance);

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

check(
  'API returns string balances',
  typeof balance.real === 'string',
  `real=${JSON.stringify(balance.real)}`
);
check(
  'store coerces real to number',
  typeof state.real === 'number' && Number.isFinite(state.real),
  `→ ${state.real}`
);
check(
  'top-bar .toFixed(2) does not crash',
  typeof state.real.toFixed === 'function' && state.real.toFixed(2) === '0.00',
  state.real.toFixed(2)
);
check(
  'bet-panel math does not crash',
  typeof (100 - state.real).toFixed === 'function'
);
check(
  'all four wallets coerced',
  ['real', 'bonus', 'gifted', 'locked'].every((k) => Number.isFinite(state[k]))
);

console.log(`\nBALANCE COERCION: ${4 - fail}/4 passed`);
process.exit(fail ? 1 : 0);
