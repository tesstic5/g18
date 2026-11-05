// e2e/games-visibility-v140.mjs — v1.4.0 live verification:
//   A) HIDE: admin hides plinko → lobby drops it INSTANTLY (cache-busted),
//      game detail 403, bet 403 → unhide fully restores.
//   B) HOT: admin hot-toggles plinko (tags ± 'hot') → lobby shows it hot.
//   C) DEPOSIT RATE: admin sets max/window-seconds → max=1+window=600 blocks
//      the 2nd deposit request; window=3s allows it after 3s; message speaks
//      seconds under a minute. Defaults restored (5/3600) at the end.
import { execSync } from 'child_process';

const B = process.env.API || 'http://localhost:4000';
let pass = 0,
  fail = 0;
const P = (n, ok, d = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookiesOf = (r) =>
  (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const csrfOf = (r) =>
  (r.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('csrf_token='))
    ?.split(';')[0]
    ?.split('=')[1] ?? '';

// ---------- admin + player sessions ----------
const al = await fetch(`${B}/api/v1/panel/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'superadmin', password: 'change-this-immediately' }),
});
const AC = cookiesOf(al);
const ACRF = csrfOf(al);
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

async function mkPlayer() {
  const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
  const su = await fetch(`${B}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      password: 'TestPass123!',
      fingerprint: {
        userAgent: 'e2e-v140',
        screenRes: '1x1',
        timezone: 'UTC',
        language: 'en',
      },
    }),
  });
  const sj = await su.json();
  const uid = sj.data.user.id;
  execSync(
    `sudo -n -u postgres psql -h /tmp -p 55432 -U postgres -d casino -c "UPDATE \\"Wallet\\" SET \\"realBalance\\"=100000 WHERE \\"userId\\"='${uid}'"`,
    { stdio: 'pipe' }
  );
  return {
    uid,
    token: sj.data.accessToken,
    cookies: cookiesOf(su),
    csrf: csrfOf(su),
  };
}

const playerA = await mkPlayer();
P('player session funded', !!playerA.token);

// fresh PF seed helper (bets + deposits need it for bets only, but harness-safe)
async function pfSeed(p) {
  const r = await fetch(`${B}/api/v1/provably-fair/active-seed`, {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  const j = await r.json().catch(() => null);
  return j?.data?.clientSeed ?? 'x';
}

// ---------- A. HIDE ----------
const hide = await panelPatch('/api/v1/panel/games/plinko', { isActive: false });
P('admin hides plinko', hide.status === 200, `status ${hide.status}`);

let lobby = await (await fetch(`${B}/api/v1/games`)).json();
P(
  'plinko gone from lobby INSTANTLY (cache-busted)',
  !lobby.data.some((g) => g.slug === 'plinko')
);

const detail = await fetch(`${B}/api/v1/games/plinko`);
const detailJson = await detail.json().catch(() => null);
P(
  'plinko detail page blocked for players',
  detail.status === 403,
  `status ${detail.status} code=${detailJson?.code}`
);

const seed1 = await pfSeed(playerA);
const betRes = await fetch(`${B}/api/v1/games/plinko/bet`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${playerA.token}`,
    Cookie: playerA.cookies,
    'x-csrf-token': playerA.csrf,
  },
  body: JSON.stringify({
    amount: 100,
    walletType: 'REAL',
    choices: { risk: 'low', rows: 8, balls: 1 },
    clientSeed: seed1,
  }),
});
const betJson = await betRes.json().catch(() => null);
P(
  'plinko bet rejected while hidden (GAME_002 = GAME_NOT_ACTIVE)',
  betRes.status === 403 &&
    (betJson?.code === 'GAME_NOT_ACTIVE' || betJson?.code === 'GAME_002'),
  `status ${betRes.status} code=${betJson?.code}`
);

const unhide = await panelPatch('/api/v1/panel/games/plinko', { isActive: true });
lobby = await (await fetch(`${B}/api/v1/games`)).json();
P(
  'unhide restores lobby + detail instantly',
  unhide.status === 200 && lobby.data.some((g) => g.slug === 'plinko'),
  `status ${unhide.status}`
);
const detail2 = await fetch(`${B}/api/v1/games/plinko`);
P('detail 200 after unhide', detail2.status === 200);

// ---------- B. HOT ----------
const panelGames = await (
  await fetch(`${B}/api/v1/panel/games`, { headers: { Cookie: AC } })
).json();
const plinkoRow = panelGames.data.find((g) => g.slug === 'plinko');
const noHot = (plinkoRow.tags ?? []).filter((t) => t !== 'hot');
const hotOn = await panelPatch('/api/v1/panel/games/plinko', {
  tags: [...noHot, 'hot'],
});
lobby = await (await fetch(`${B}/api/v1/games`)).json();
const plinkoLobby = lobby.data.find((g) => g.slug === 'plinko');
P(
  'hot toggle lands in lobby instantly',
  hotOn.status === 200 && plinkoLobby.tags.includes('hot'),
  `tags=${JSON.stringify(plinkoLobby?.tags)}`
);
const hotOff = await panelPatch('/api/v1/panel/games/plinko', { tags: noHot });
lobby = await (await fetch(`${B}/api/v1/games`)).json();
P(
  'untoggle removes hot instantly',
  hotOff.status === 200 &&
    !lobby.data.find((g) => g.slug === 'plinko').tags.includes('hot')
);

// ---------- C. DEPOSIT RATE (seconds-driven) ----------
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000525cf00000000a49444154789c626001000000ffff030000060005' +
    '57bfabd40000000049454e44ae426082',
  'hex'
);
async function freshProof(p) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'proof.png');
  const r = await fetch(`${B}/api/v1/deposits/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.token}`,
      Cookie: p.cookies,
      'x-csrf-token': p.csrf,
    },
    body: form,
  });
  const j = await r.json().catch(() => null);
  return j?.data?.objectKey;
}
async function deposit(p, proofKey) {
  const r = await fetch(`${B}/api/v1/deposits/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.token}`,
      Cookie: p.cookies,
      'x-csrf-token': p.csrf,
    },
    body: JSON.stringify({
      amount: 100,
      paymentMethod: 'easypaisa',
      senderAccount: '03001234567',
      proofObjectKey: proofKey,
    }),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

const set1 = await panelPatch('/api/v1/panel/settings', {
  deposit_rate_max: 1,
  deposit_rate_window_sec: 600,
});
P(
  'admin sets deposit max=1 / window=600s',
  set1.status === 200,
  `status ${set1.status} ${JSON.stringify(set1.json).slice(0, 80)}`
);

const k1 = await freshProof(playerA);
const d1 = await deposit(playerA, k1);
P('deposit #1 accepted under max=1', d1.status === 200, `status ${d1.status}`);
const k2 = await freshProof(playerA);
const d2 = await deposit(playerA, k2);
P(
  'deposit #2 inside 600s window → 429',
  d2.status === 429 && Number(d2.json?.details?.retryAfter ?? 0) > 0,
  `status ${d2.status} retryAfter=${d2.json?.details?.retryAfter} msg=${(d2.json?.message ?? '').slice(0, 60)}`
);

const set2 = await panelPatch('/api/v1/panel/settings', {
  deposit_rate_max: 1,
  deposit_rate_window_sec: 3,
});
P('admin tightens window to 3 SECONDS', set2.status === 200);
const playerB = await mkPlayer();
const kb1 = await freshProof(playerB);
const db1 = await deposit(playerB, kb1);
P('playerB deposit #1 ok', db1.status === 200, `status ${db1.status}`);
const kb2 = await freshProof(playerB);
const db2 = await deposit(playerB, kb2);
P(
  'playerB deposit #2 within 3s → 429 (message in seconds)',
  db2.status === 429 && /second/i.test(db2.json?.message ?? ''),
  `status ${db2.status} msg="${(db2.json?.message ?? '').slice(0, 70)}"`
);
await sleep(3600);
const kb3 = await freshProof(playerB);
const db3 = await deposit(playerB, kb3);
P(
  'playerB deposit #3 after the 3-second gap → ALLOWED',
  db3.status === 200,
  `status ${db3.status}`
);

// restore production defaults
const restore = await panelPatch('/api/v1/panel/settings', {
  deposit_rate_max: 5,
  deposit_rate_window_sec: 3600,
});
P('defaults restored (5 / 3600s)', restore.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
