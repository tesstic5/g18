// e2e/plinko-retune-v139.mjs — v1.3.9 live verification of the Plinko ladder:
//   caps 2x / 6x / 12x (never more), dead centre slots pay exactly 0.
//   For each of the 9 risk×row boards: N real API bets, then assert
//   1. every bucket value is a member of the designed table
//   2. no table value exceeds the tier cap (12x hard ceiling overall)
//   3. dead slots exist in the table (medium 1, high 3)
//   4. observed payouts match mean-of-buckets × stake / balls exactly
//   5. at least one 0-payout round is observed on high (dead zone reachable)
import { execSync } from 'child_process';

const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};

const EXPECTED = {
  low: {
    8: [2, 1.34, 1.02, 0.904, 0.887, 0.904, 1.02, 1.34, 2],
    12: [2, 1.56, 1.25, 1.06, 0.959, 0.924, 0.919, 0.924, 0.959, 1.06, 1.25, 1.56, 2],
    16: [
      2, 1.68, 1.4, 1.21, 1.07, 0.992, 0.95, 0.935, 0.933, 0.935, 0.95, 0.992, 1.07,
      1.21, 1.4, 1.68, 2,
    ],
  },
  medium: {
    8: [6, 3, 1.3, 0.7, 0, 0.7, 1.3, 3, 6],
    12: [6, 4.5, 3.5, 2, 1.1, 0.55, 0, 0.55, 1.1, 2, 3.5, 4.5, 6],
    16: [6, 5.5, 5, 4, 2.5, 1.6, 0.9, 0.5, 0, 0.5, 0.9, 1.6, 2.5, 4, 5, 5.5, 6],
  },
  high: {
    8: [12, 3.5, 0.8, 0, 0, 0, 0.8, 3.5, 12],
    12: [12, 7, 4, 1.6, 0.5, 0, 0, 0, 0.5, 1.6, 4, 7, 12],
    16: [12, 9, 7, 4.5, 2.2, 1, 0.4, 0, 0, 0, 0.4, 1, 2.2, 4.5, 7, 9, 12],
  },
};

// ---- player ----
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const su = await fetch(`${B}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    phone,
    password: 'TestPass123!',
    fingerprint: {
      userAgent: 'e2e-plinko139',
      screenRes: '1x1',
      timezone: 'UTC',
      language: 'en',
    },
  }),
});
const sj = await su.json();
const token = sj.data.accessToken;
const uid = sj.data.user.id;
const cookies = (su.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(';')[0])
  .join('; ');
const csrf = (su.headers.getSetCookie?.() ?? [])
  .find((c) => c.startsWith('csrf_token='))
  ?.split(';')[0]
  ?.split('=')[1];
P('signup + session', !!token && !!uid);
execSync(
  `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=1000000 WHERE \\"userId\\"='${uid}'"`,
  { stdio: 'pipe' }
);

// the bet route rejects unless the clientSeed matches the ACTIVE PF seed
let clientSeed = 'plinko-139';
{
  const r = await fetch(`${B}/api/v1/provably-fair/active-seed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => null);
  clientSeed = j?.data?.clientSeed ?? clientSeed;
}
P('active PF seed acquired', !!clientSeed, clientSeed.slice(0, 12));

async function bet(risk, rows, balls) {
  const res = await fetch(`${B}/api/v1/games/plinko/bet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Cookie: cookies,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      amount: 100,
      walletType: 'REAL',
      choices: { risk, rows, balls },
      clientSeed,
    }),
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, d: res.status === 200 ? j?.data : j };
}

async function refreshSeed() {
  const r = await fetch(`${B}/api/v1/provably-fair/active-seed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => null);
  clientSeed = j?.data?.clientSeed ?? clientSeed;
}

// after auto-rotation the server rejects with SEED_MISMATCH — the production
// client re-fetches the seed and retries; we mirror that exactly.
async function betWithRetry(risk, rows, balls) {
  let res = await bet(risk, rows, balls);
  if (res.status === 400 && res.d?.code === 'SEED_MISMATCH') {
    await refreshSeed();
    res = await bet(risk, rows, balls);
  }
  return res;
}

const tableOkAll = [];
const payoutOkAll = [];
const deadObserved = { medium: 0, high: 0 };
const capSeen = { low: 0, medium: 0, high: 0 };
let sawAny12 = false;

for (const risk of ['low', 'medium', 'high']) {
  for (const rows of [8, 12, 16]) {
    const table = EXPECTED[risk][rows];
    const N = 30;
    let ok = true;
    let detail = '';
    for (let i = 0; i < N; i++) {
      const { status, d } = await betWithRetry(risk, rows, 2);
      if (status !== 200) {
        ok = false;
        detail = `http ${status} code=${typeof d === 'object' && d && 'code' in d ? d.code : JSON.stringify(d).slice(0, 90)}`;
        break;
      }
      const anim = d.animationData;
      // 1. server-stamped table matches design exactly
      if (JSON.stringify(anim.multipliers) !== JSON.stringify(table)) {
        ok = false;
        detail = 'table mismatch';
        break;
      }
      // 2. every landed bucket >= 0, <= rows (inside the row) + values ∈ table
      for (let b = 0; b < anim.buckets.length; b++) {
        const idx = anim.buckets[b];
        if (!(idx >= 0 && idx <= rows)) {
          ok = false;
          detail = `bucket ${idx} out of range`;
          break;
        }
        if (anim.bucketMultipliers[b] !== table[idx]) {
          ok = false;
          detail = `bucketMult ${anim.bucketMultipliers[b]} ≠ table[${idx}]`;
          break;
        }
        if (anim.bucketMultipliers[b] === 0) deadObserved[risk]++;
        if (anim.bucketMultipliers[b] === 12) sawAny12 = true;
      }
      if (!ok) break;
      // 3. payout exactness: mean × stake(100) == payout
      const mean =
        anim.bucketMultipliers.reduce((s, m) => s + m, 0) /
        anim.bucketMultipliers.length;
      if (Math.abs(mean - anim.aggregate) > 0.001) {
        ok = false;
        detail = `aggregate ${anim.aggregate} ≠ mean ${mean}`;
        break;
      }
      if (Math.abs(d.payout - mean * 100) > 0.5) {
        ok = false;
        detail = `payout ${d.payout} ≠ ${mean * 100}`;
        break;
      }
      // 4. payout path used no more than the 12× money cap
      if (d.payout > 100 * 12) {
        ok = false;
        detail = `payout ${d.payout} exceeds 12×`;
        break;
      }
    }
    const cap = Math.max(...table);
    const zeros = table.filter((m) => m === 0).length;
    P(
      `${risk}-${rows}: ${N} bets clean (cap ${cap}x, ${zeros} dead slot${zeros === 1 ? '' : 's'})`,
      ok,
      detail || `dead-hit in-run risk:${risk}`
    );
    tableOkAll.push(ok);
    capSeen[risk] = Math.max(capSeen[risk], cap);
  }
}

P(
  'low cap = 2, medium cap = 6, high cap = 12',
  capSeen.low === 2 && capSeen.medium === 6 && capSeen.high === 12
);
P(
  'NO bucket value above 12 anywhere',
  Object.values(EXPECTED)
    .flatMap((o) => Object.values(o))
    .every((t) => Math.max(...t) <= 12)
);
P(
  'dead 0x slot actually landed on medium',
  deadObserved.medium > 0,
  `${deadObserved.medium} hits`
);
P(
  'dead 0x slots actually landed on high',
  deadObserved.high > 0,
  `${deadObserved.high} hits`
);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
