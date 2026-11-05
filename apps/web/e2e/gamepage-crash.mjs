// e2e/gamepage-crash.mjs — D-084 regression: BetHistory must read .data from
// the history API response ({ data, pagination }). Before the fix, the whole
// object was treated as an array → rows.map() crash → "Something went wrong"
// for LOGGED-IN users on every game page.
const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};

const fp = { userAgent: 'e2e-gp', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const signup = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const token = (await signup.json()).data.accessToken;

// the EXACT client code path (mirrors fixed BetHistory):
const res = await fetch(`${B}/api/v1/games/coin-flip/history?page=1&pageSize=20`, {
  headers: { Authorization: `Bearer ${token}` },
});
const json = await res.json();
const historyPage = json.data; // { data, pagination }

// OLD code (would crash):
let oldCrash = false;
try {
  const rows = historyPage ?? [];
  rows.map((r) => r.id);
} catch {
  oldCrash = true;
}
P(
  'OLD code crashed on logged-in history',
  oldCrash === true,
  'rows.map on {data,pagination} throws'
);

// NEW code:
const myBets = historyPage?.data ?? [];
let newOk = true;
try {
  myBets.map((r) => r.id);
} catch {
  newOk = false;
}
P(
  'NEW code reads .data and maps fine',
  newOk === true && Array.isArray(myBets),
  `rows ${myBets.length}`
);
P('pagination present', !!historyPage?.pagination);

console.log(`\nGAME PAGE CRASH: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
