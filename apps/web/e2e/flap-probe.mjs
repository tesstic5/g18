// FLAP PROBE — simulates production's Redis connectivity blip (EAI_AGAIN-style)
// while aviator/crash-x + wingo are running, and proves the shared rounds
// survive it. Connectivity is cut by repeatedly CLIENT KILL-ing all Redis
// client connections for ~8s: the server stays up, round data stays intact,
// but every Redis call fails — exactly what a docker DNS hiccup looks like.
//
// PASS criteria:
//  1. The in-flight crash round CRASHES on the SAME roundId after the blip
//     (no silent round reset), and the placed bet settles (BUST/CASHOUT),
//     never disappears.
//  2. The next round-start arrives ~5s after the crash (continuous cadence).
//  3. Wingo 30s keeps producing results before/during/after the blip
//     (max gap between consecutive results < 45s).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const req = createRequire(new URL('../package.json', import.meta.url));
const { io } = req('socket.io-client');

const API = 'http://localhost:4000/api/v1';
const FP = {
  userAgent: 'flap-probe',
  screenRes: '1x1',
  timezone: 'UTC',
  language: 'en',
};
const log = (tag, msg) =>
  console.log(
    `[${new Date().toISOString().slice(11, 19)}.${String(Date.now() % 1000).padStart(3, '0')}] ${tag} ${msg}`
  );

async function call(method, path, { body, token } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const A = await (async () => {
  const r = await call('POST', '/auth/signup', {
    body: {
      phone: `+9237${10000000 + Math.floor(Math.random() * 89999999)}`,
      password: 'TestPass123!',
      fingerprint: FP,
    },
  });
  const tok = r.json?.data?.accessToken;
  const uid = r.json?.data?.user?.id;
  if (!tok || !uid) throw new Error('signup failed: ' + JSON.stringify(r.json));
  return { token: tok, uid };
})();
const uid = A.uid;
log('AUTH', `logged in uid=${uid}`);

// The probe re-bets ₨100 every round until a ≥1.5x flight appears — a long
// hunt on the crash-heavy tuning can drain the account mid-window. Admin-fund
// once up front (a low-balance bet earlier in the window makes a reset look
// like a never-injected outage — the run that taught this wasted 20 minutes).
{
  // panel session = cookies + CSRF header (same flow as wingo-ui.mjs)
  const al = await fetch(`${API}/panel/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'superadmin',
      password: 'change-this-immediately',
    }),
  });
  const cookies = (al.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const csrf =
    (al.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith('csrf_token='))
      ?.split('=')[1]
      ?.split(';')[0] ?? '';
  const fund = await fetch(`${API}/panel/users/${uid}/fund`, {
    method: 'POST',
    headers: {
      Cookie: cookies,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ walletType: 'real', amount: 10000 }),
  });
  log('AUTH', `admin fund → ${fund.status}`);
}

// ── sockets ────────────────────────────────────────────────────────────────
const events = []; // {t, ev, roundId?}
const rec = (ev, p = {}) => {
  events.push({ t: Date.now(), ev, ...p });
};

const sock = io('http://localhost:4000', {
  auth: { token: A.token },
  transports: ['websocket'],
});
sock.on('connect', () => {
  // H-16 throttles joins to ~2/sec/socket — a second emit in the same tick is
  // silently dropped, so stagger the room joins.
  sock.emit('game:join', { slug: 'crash-x' });
  setTimeout(() => sock.emit('game:join', { slug: 'wingo' }), 700);
});

let currentRoundId = null;
let injected = false;
let outageStart = 0,
  outageEnd = 0;
let betRound = null;
let lastTickAt = 0;

sock.on('crash-x:round-start', (p) => {
  currentRoundId = p.roundId;
  rec('crash:start', { roundId: p.roundId });
  log('CRASH', `⏱ round-start ${p.roundId.slice(0, 8)}`);
  if (!injected) {
    // keep betting each round until we get a flight long enough for the blip
    call('POST', '/games/crash-x/bet', {
      token: A.token,
      body: {
        amount: 100,
        requestId: crypto.randomUUID(),
        choices: {},
        clientSeed: 'flap-seed',
      },
    }).then((b) => {
      const ok = b.status === 200 || b.status === 201;
      if (ok) {
        betRound = p.roundId;
        log('CRASH', `   bet PLACED on ${p.roundId.slice(0, 8)} (${b.status})`);
      } else
        log(
          'CRASH',
          `   bet rejected: ${b.status} ${b.json?.code ?? ''} ${b.json?.message ?? ''}`
        );
    });
  }
});
sock.on('crash-x:tick', (p) => {
  const now = Date.now();
  if (now - lastTickAt > 300) {
    lastTickAt = now;
    rec('crash:tick', { m: p.multiplier });
  }
  // inject mid-flight once the plane clearly survived takeoff
  if (!injected && betRound && p.multiplier >= 1.5 && betRound === currentRoundId) {
    injected = true;
    outageStart = now;
    log(
      'FLAP',
      `✂ cutting Redis connectivity for 8s (mid-flight @ ${p.multiplier.toFixed(2)}x, round ${currentRoundId.slice(0, 8)})`
    );
    rec('flap:outage-start');
    const killer = spawn('bash', [
      '-c',
      'for i in $(seq 1 20); do redis-cli -p 56379 CLIENT KILL TYPE normal >/dev/null 2>&1; sleep 0.4; done; echo KILL-LOOP-DONE',
    ]);
    killer.stdout.on('data', (d) => log('FLAP', String(d).trim()));
    setTimeout(() => {
      outageEnd = Date.now();
      log('FLAP', '⟳ connectivity restored');
      rec('flap:outage-end');
    }, 8100);
  }
});
sock.on('crash-x:crash', (p) => {
  log('CRASH', `💥 crash @ ${p.crashPoint}x round=${p.roundId.slice(0, 8)}`);
  rec('crash:crash', { roundId: p.roundId, crashPoint: p.crashPoint });
});
sock.on('crash-x:my-result', (p) => {
  log('CRASH', `   MY RESULT: ${p.result} mult=${p.multiplier} payout=${p.payout}`);
  rec('crash:my-result', { result: p.result, payout: p.payout });
});
let lastWingoResultAt = null;
const wingoGaps = [];
sock.on('wingo:result', (p) => {
  if (p.durationSec !== 30) return;
  const now = Date.now();
  if (lastWingoResultAt) wingoGaps.push(now - lastWingoResultAt);
  lastWingoResultAt = now;
  log('WINGO', `🎲 result ${p.result} (${p.color})`);
  rec('wingo:result');
});
sock.on('wingo:round-start', (p) => {
  if (p.durationSec === 30) rec('wingo:start');
});

// ── run window: wait for injection + aftermath ─────────────────────────────
// Crash is tuned crash-heavy (≥80% bust before 1.5×): give the hunt several
// minutes so the blip genuinely lands mid-flight instead of forcing reruns.
const deadline = Date.now() + 420_000;
await new Promise((resolve) => {
  const iv = setInterval(() => {
    const wingoCount = events.filter((e) => e.ev === 'wingo:result').length;
    // injection may land in the first minute — don't resolve until the wingo
    // side has produced the ≥5 results its check demands (30s cadence), with
    // a hard cap so a dead wingo can never hang the probe.
    const hardCap = (injected ? outageEnd : Date.now()) + 200_000;
    if (
      injected &&
      outageEnd &&
      Date.now() > outageEnd + 25_000 &&
      (wingoCount >= 5 || Date.now() > hardCap)
    ) {
      clearInterval(iv);
      resolve();
    } else if (!injected && Date.now() > deadline) {
      clearInterval(iv);
      log('FLAP', '⚠ no long flight within window — still analyzing');
      resolve();
    }
  }, 500);
});
sock.disconnect();

// ── verdicts ───────────────────────────────────────────────────────────────
console.log('\n════════ FLAP VERDICT ════════');
let pass = true;
const check = (ok, label) => {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) pass = false;
};

if (injected) {
  const startsAfterOutage = events.filter(
    (e) => e.ev === 'crash:start' && e.t > outageStart
  );
  const crashesAfterOutage = events.filter(
    (e) => e.ev === 'crash:crash' && e.t > outageStart
  );
  const origCrash = crashesAfterOutage.find((c) => c.roundId === betRound);
  const resetFirst =
    startsAfterOutage.length && (!origCrash || startsAfterOutage[0].t < origCrash.t);
  check(
    !!origCrash,
    `in-flight round ${betRound?.slice(0, 8)} reached a CRASH after the blip (not silently dropped)`
  );
  check(
    !resetFirst,
    'no fresh round-start superseded the in-flight round (round continuity kept)'
  );
  const settled = events.find((e) => e.ev === 'crash:my-result' && e.t > outageStart);
  check(
    !!settled,
    `bet settled after blip (${settled?.result ?? '—'}) — stake did not vanish`
  );
  if (origCrash) {
    const nextStart = startsAfterOutage.find((s) => s.t > origCrash.t);
    check(
      !!nextStart && nextStart.t - origCrash.t < 12_000,
      `next round-start ${nextStart ? Math.round((nextStart.t - origCrash.t) / 1000) + 's' : '—'} after crash (continuous cadence)`
    );
  }
} else {
  check(false, 'outage was never injected (flights ended too fast) — rerun');
}
const maxGap = wingoGaps.length ? Math.max(...wingoGaps) : Infinity;
check(
  wingoGaps.length >= 3,
  `wingo produced ${wingoGaps.length + 1} results over the window`
);
check(
  maxGap < 45_000,
  `wingo cadence continuous (max result gap ${Math.round(maxGap / 1000)}s < 45s — cycle survived the blip)`
);
console.log(
  pass ? '\n🏁 FLAP-RESILIENT: all checks passed' : '\n💥 FLAP FAILURE — see ❌ above'
);
process.exit(pass ? 0 : 1);
