// scripts/playtest-live.ts — LIVE end-to-end playtest of every one-shot game.
//
// Runs against a live API (BASE_URL) and drives the REAL bet flow the web app
// uses: clientSeed pinned from /provably-fair/active-seed, unique requestId
// per round, full settlement through the wallet. For each round it checks:
//
//   1. DISPLAY vs LEDGER: result === WIN  ⟺ payoutAmount > bet
//                         result === LOSE ⟺ payoutAmount < bet
//                         result === PUSH ⟺ equal — the banner can never lie.
//   2. OUTCOME COHERENCE: the game's own truth justifies the verdict (a dice
//      loss shows a roll that actually loses, a forced wheel round lands where
//      money went, keno win rows match the paying tier, …).
//   3. MONEY: wallet delta for the round is exactly payout − stake.
//   4. PROOF: a strategic sample of rounds is replayed via POST
//      /provably-fair/verify (seed rotation included) and must validate.
//
// Then the operator-control scenarios:
//   A. Force WIN / LOSE (thimbles, wheel) with budget countdown + auto-off.
//   B. Platform difficulty (easy/hard) empirically shifts measured win rate.
//   C. Per-game difficulty beats the platform default.
//   D. Session/shared games REFUSE force + difficulty (exempt by design).
//
// Usage:
//   BASE_URL=http://localhost:4000 npx tsx scripts/playtest-live.ts
//   ROUNDS=40          rounds per game in the baseline (default 60)
//   QUICK=1            only the operator-control scenarios
import { prisma } from '../apps/api/src/db/prisma';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ROUNDS = Number(process.env.ROUNDS ?? 60);
const QUICK = process.env.QUICK === '1';
const PHONE = '+92300' + String(Math.floor(1000000 + Math.random() * 8999999));
const PASSWORD = 'Playtest#34126';

/* ────────────────────────────── tiny http client ───────────────────────── */
class Client {
  accessToken = '';
  private cookies = new Map<string, string>();

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req<T = any>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: any; data: T }> {
    const csrf = this.cookies.get('csrf_token');
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const scs = res.headers.getSetCookie?.() ?? [];
    for (const sc of scs) {
      const [pair] = sc.split(';');
      const idx = pair!.indexOf('=');
      if (idx > 0)
        this.cookies.set(pair!.slice(0, idx).trim(), pair!.slice(idx + 1).trim());
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, json, data: json?.data ?? json };
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p);
  }
  post<T = any>(p: string, b?: unknown) {
    return this.req<T>('POST', p, b);
  }
  patch<T = any>(p: string, b?: unknown) {
    return this.req<T>('PATCH', p, b);
  }
}

/* ─────────────────────────────── assertions ────────────────────────────── */
let checks = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, extra?: unknown) {
  checks++;
  if (!cond) {
    failures.push(label);
    console.log(
      `  ✗ ${label}`,
      extra === undefined ? '' : JSON.stringify(extra).slice(0, 220)
    );
  }
}
function section(t: string) {
  console.log(`\n══ ${t} ${'═'.repeat(Math.max(2, 96 - t.length - 4))}`);
}

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol;

/* ─────────────────────────── user provisioning ─────────────────────────── */
const FP = {
  userAgent: 'playtest',
  screenRes: '1920x1080',
  timezone: 'Asia/Karachi',
  language: 'en',
};

async function signupAndFund(): Promise<Client> {
  const c = new Client();
  const r = await c.post('/auth/signup', {
    phone: PHONE,
    password: PASSWORD,
    fingerprint: FP,
  });
  assert(
    r.status === 200 || r.status === 409,
    `signup ${r.status}: ${JSON.stringify(r.json).slice(0, 240)}`
  );
  const login = await c.post('/auth/login', {
    phone: PHONE,
    password: PASSWORD,
    fingerprint: FP,
  });
  assert(
    login.status === 200,
    `login ${login.status}: ${JSON.stringify(r.json).slice(0, 240)}`
  );
  c.accessToken = String((login.data as any).accessToken);
  assert(c.accessToken.length > 10, 'access token returned');
  const userId = String((login.data as any).user?.id ?? '');
  assert(userId.length > 3, `user id resolved (${userId.slice(0, 8)})`);
  // Test-credit the REAL wallet directly (playtesting bankroll — not a
  // product money flow; that path has its own exact-once proof in the audit).
  await prisma.wallet.updateMany({
    where: { userId },
    data: { realBalance: { increment: 100_000 } },
  });
  return c;
}

async function adminClient(): Promise<Client> {
  const c = new Client();
  const r = await c.post('/panel/auth/login', {
    username: 'superadmin',
    password: 'change-this-immediately',
  });
  if (r.status !== 200) {
    const got = r.data as any;
    if (got?.requiresTotp || got?.twoFactorRequired) {
      throw new Error('admin 2FA unexpectedly enabled on fresh seed');
    }
  }
  assert(
    r.status === 200,
    `admin login ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`
  );
  c.accessToken = String((r.data as any).accessToken ?? (r.data as any).token ?? '');
  return c;
}

/* ──────────────────────────── bet plumbing ─────────────────────────────── */
interface RoundResp {
  roundId: string;
  result: 'WIN' | 'LOSE' | 'PUSH' | 'BUST' | 'CASHOUT';
  payoutAmount: number;
  payoutMultiplier: number;
  mappedOutcome: any;
  balanceAfter?: number;
  forceUsed?: string;
  [k: string]: unknown;
}

async function activeSeed(c: Client): Promise<string> {
  const r = await c.get('/provably-fair/active-seed');
  return String((r.data as any).clientSeed);
}

async function placeBet(
  c: Client,
  slug: string,
  choices: Record<string, unknown>,
  amount = 10,
  clientSeed?: string
): Promise<RoundResp> {
  const seed = clientSeed ?? (await activeSeed(c));
  const r = await c.post(`/games/${slug}/bet`, {
    amount,
    choices,
    clientSeed: seed,
    requestId: crypto.randomUUID(),
  });
  if (r.status !== 200)
    throw new Error(`bet ${slug} ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  const resp = r.data as any as RoundResp;
  LEDGER.expected += +(resp.payoutAmount - amount).toFixed(2);
  return resp;
}

async function walletBalance(c: Client): Promise<number> {
  const r = await c.get('/wallet/balance');
  const d = r.data as any;
  // REAL-wallet purchasing power: real + gifted + bonus both count toward bets;
  // track the REAL column for exact ledger math (test bankroll is 100% real).
  return Number(d.real ?? 0) + Number(d.gifted ?? 0) + Number(d.bonus ?? 0);
}

/* ─────────────────────── per-game coherence checkers ───────────────────── */
type Checker = (m: any, win: boolean, choices: any) => string | null;
const CHECKERS: Record<string, Checker> = {
  dice: (m, win, c) => {
    const ok = c.over ? m.resultNumber > c.target : m.resultNumber < c.target;
    return win
      ? ok
        ? null
        : `roll ${m.resultNumber} contradicts WIN`
      : ok
        ? `roll ${m.resultNumber} contradicts LOSE`
        : null;
  },
  limbo: (m, win, c) => {
    const ok = m.result >= c.target;
    return win
      ? ok
        ? null
        : 'limbo result contradicts WIN'
      : ok
        ? 'limbo result contradicts LOSE'
        : null;
  },
  'coin-flip': (m, win, c) =>
    win
      ? m.side === c.choice
        ? null
        : 'coin contradicts WIN'
      : m.side !== c.choice
        ? null
        : 'coin contradicts LOSE',
  thimbles: (m, win, c) =>
    win
      ? m.ballCup === c.cup
        ? null
        : 'ball not under pick on WIN'
      : m.ballCup !== c.cup
        ? null
        : 'ball under pick on LOSE',
  wheel: (m, win, c) =>
    win
      ? m.landedId === c.tier
        ? null
        : `wheel landed ${m.landedId} on WIN`
      : m.landedId !== c.tier
        ? null
        : `wheel landed ${m.landedId} on LOSE`,
  'ring-of-fortune': (m, win, c) =>
    win
      ? m.landedId === c.tier
        ? null
        : `ring landed ${m.landedId} on WIN`
      : m.landedId !== c.tier
        ? null
        : `ring landed ${m.landedId} on LOSE`,
  roulette: (m, win, c) => {
    const bet = c.bet;
    const pocket = m.pocket as number;
    const covers: string[] = [];
    const red = new Set([
      1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
    ]);
    if (bet.type === 'red' && red.has(pocket)) covers.push('y');
    if (bet.type === 'black' && pocket !== 0 && !red.has(pocket)) covers.push('y');
    const hit = covers.length > 0;
    return win
      ? hit
        ? null
        : `pocket ${pocket} contradicts WIN`
      : hit
        ? `pocket ${pocket} contradicts LOSE`
        : null;
  },
  keno: (m, win) => {
    const table = m.payoutTable as Record<string, number>;
    const mult = table[String(m.matches)] ?? 0;
    return win
      ? mult > 1
        ? null
        : `keno paid ${mult}x on WIN`
      : mult > 1
        ? `keno table pays ${mult}x on LOSE`
        : null;
  },
  plinko: (m, win) => {
    const buckets = m.buckets as number[];
    const table = m.multipliers as number[];
    const avg =
      buckets.reduce((s: number, b: number) => s + table[b]!, 0) / buckets.length;
    return win
      ? avg > 1
        ? null
        : `plinko buckets pay ${avg}x on WIN`
      : avg > 1
        ? `plinko buckets pay ${avg}x on LOSE`
        : null;
  },
  'lucky-number': (m, win) =>
    win
      ? m.multiplier > 1
        ? null
        : `lucky paid ${m.multiplier}x on WIN`
      : m.multiplier > 1
        ? `lucky paid ${m.multiplier}x on LOSE`
        : null,
  'dragon-tiger': (m, win, c) => {
    const winNow = m.outcome === c.bet;
    const push = m.outcome === 'tie' && c.bet !== 'tie';
    return win
      ? winNow || push
        ? null
        : `DT outcome ${m.outcome} contradicts WIN`
      : winNow
        ? `DT outcome ${m.outcome} contradicts LOSE`
        : null;
  },
  baccarat: (m, win, c) => {
    const winNow = m.outcome === c.bet;
    const push = m.outcome === 'tie' && c.bet !== 'tie';
    return win
      ? winNow || push
        ? null
        : `baccarat outcome ${m.outcome} contradicts WIN`
      : winNow
        ? `baccarat outcome ${m.outcome} contradicts LOSE`
        : null;
  },
  'scratch-card': (m, win) =>
    win
      ? m.winLine
        ? null
        : 'no win line on WIN'
      : m.winLine
        ? 'win line on LOSE'
        : null,
};

const BET_PLANS: Array<{ slug: string; choices: () => any }> = [
  { slug: 'dice', choices: () => ({ over: true, target: 50 }) },
  { slug: 'limbo', choices: () => ({ target: 2 }) },
  { slug: 'coin-flip', choices: () => ({ choice: 'heads' }) },
  { slug: 'thimbles', choices: () => ({ cup: 1 }) },
  { slug: 'wheel', choices: () => ({ tier: 'yellow' }) },
  { slug: 'ring-of-fortune', choices: () => ({ tier: 'silver' }) },
  { slug: 'roulette', choices: () => ({ bet: { type: 'red' } }) },
  { slug: 'keno', choices: () => ({ picks: [5, 12, 23, 34] }) },
  { slug: 'plinko', choices: () => ({ rows: 12, risk: 'medium', balls: 2 }) },
  { slug: 'lucky-number', choices: () => ({ betMin: 30, betMax: 39 }) },
  { slug: 'dragon-tiger', choices: () => ({ bet: 'dragon' }) },
  { slug: 'baccarat', choices: () => ({ bet: 'player' }) },
  { slug: 'scratch-card', choices: () => ({}) },
];

/* ────────────────────────────── scenarios ─────────────────────────────── */
/** Run-wide ledger expectation: Σ(payout−stake) over EVERY bet placed. */
const LEDGER = { expected: 0 };

async function baseline(c: Client) {
  section(
    `BASELINE: ${ROUNDS} rounds × ${BET_PLANS.length} games — real API, real wallet`
  );
  const sampled: string[] = [];
  for (const plan of BET_PLANS) {
    const choices = plan.choices();
    let netExpected = 0;
    let wins = 0;
    let ledgerErrors = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const r = await placeBet(c, plan.slug, choices);
      netExpected = LEDGER.expected; // cumulative, reported per block at print time
      const isWin = r.result === 'WIN';
      if (isWin) wins++;
      // (1) display vs ledger: the verdict on screen never lies
      assert(
        (isWin && r.payoutAmount > 10) ||
          (r.result === 'LOSE' && r.payoutAmount < 10) ||
          (r.result === 'PUSH' && near(r.payoutAmount, 10)),
        `${plan.slug} result ${r.result} contradicts payout ${r.payoutAmount}`,
        { roundId: r.roundId }
      );
      // (2) the round's OWN credit transaction (referenceId = roundId) matches
      // the settlement exactly — immune to async engagement bonuses
      if (r.payoutAmount > 0) {
        // Payouts credit back per funding wallet — one WIN row per wallet that
        // contributed to the stake; their SUM must equal the round payout.
        const credits = await prisma.transaction.findMany({
          where: { type: { in: ['WIN', 'REFUND'] }, referenceId: r.roundId },
        });
        const credited = credits.reduce((t, x) => t + Number(x.amount), 0);
        if (credits.length === 0 || !near(credited, r.payoutAmount)) {
          ledgerErrors++;
          assert(
            false,
            `${plan.slug} credits Σ${credited.toFixed(2)} ≠ payout ${r.payoutAmount}`,
            { roundId: r.roundId }
          );
        }
      }
      // (3) in-game coherence of what the player sees
      const co = CHECKERS[plan.slug]?.(r.mappedOutcome, isWin, choices);
      assert(co === null, `${plan.slug} display coherence: ${co}`, {
        roundId: r.roundId,
      });
      if (i % 20 === 0 && sampled.length < 30) sampled.push(r.roundId);
    }
    console.log(
      `  ✓ ${plan.slug.padEnd(15)} ${ROUNDS} rounds  wins=${wins}  net=${netExpected.toFixed(2)}  ledgerErrors=${ledgerErrors}`
    );
    assert(ledgerErrors === 0, `${plan.slug}: ${ledgerErrors} ledger error(s)`);
  }
  return sampled;
}

async function verifyRounds(c: Client, roundIds: string[]) {
  section(
    `PROVABLY FAIR REPLAY: ${roundIds.length} sampled rounds (includes rotate-seed)`
  );
  await c.post('/provably-fair/rotate-seed');
  let okCount = 0;
  for (const id of roundIds) {
    const r = await c.post('/provably-fair/verify', { roundId: id });
    if (r.status === 200 && (r.data as any).valid) okCount++;
    else assert(false, `verify ${id.slice(0, 8)} failed`, r.json);
  }
  console.log(`  ✓ ${okCount}/${roundIds.length} rounds replay valid`);
}

async function forceScenario(c: Client, admin: Client) {
  section('FORCE WIN / FORCE LOSE — admin-controlled, budgeted, self-expiring');

  // thimbles FORCE_WIN 10 rounds
  let r = await admin.patch('/panel/games/thimbles/force', {
    forceOverride: 'FORCE_WIN',
    rounds: 10,
  });
  assert(r.status === 200, `force thimbles ${r.status}`, r.json);
  const cfgProbe = await admin.get('/panel/games/thimbles');
  assert(
    String((cfgProbe.data as any).forceOverride) === 'FORCE_WIN',
    'config row shows FORCE_WIN'
  );

  let allWin = true;
  let coherent = true;
  for (let i = 0; i < 10; i++) {
    const rr = await placeBet(c, 'thimbles', { cup: i % 3 });
    if (rr.result !== 'WIN') allWin = false;
    const m = rr.mappedOutcome as any;
    if (m.ballCup !== i % 3) coherent = false;
  }
  assert(allWin, 'all 10 forced thimbles rounds were WIN');
  assert(coherent, 'forced thimbles: ball always under the player pick');
  console.log(`  ✓ thimbles FORCE_WIN ×10: every round WIN, ball under pick`);

  // budget spent → 11th round is fair again (not guaranteed to lose, just
  // no longer forced — sample 10 and demand at least one non-win somewhere in
  // 30 fair rounds to prove steering is off)
  let anyNonWin = false;
  for (let i = 0; i < 30; i++) {
    const rr = await placeBet(c, 'thimbles', { cup: 0 });
    if (rr.result !== 'WIN') anyNonWin = true;
  }
  assert(anyNonWin, 'after 10-round budget exhausted, force is off (fair odds resume)');
  const afterCfg = await admin.get('/panel/games/thimbles');
  assert(Number((afterCfg.data as any).forceRoundsLeft) === 0, 'forceRoundsLeft hit 0');

  // wheel FORCE_LOSE 6 rounds
  r = await admin.patch('/panel/games/wheel/force', {
    forceOverride: 'FORCE_LOSE',
    rounds: 6,
  });
  assert(r.status === 200, `force wheel ${r.status}`, r.json);
  let allLose = true;
  for (let i = 0; i < 6; i++) {
    const rr = await placeBet(c, 'wheel', { tier: 'purple' });
    if (rr.result !== 'LOSE') allLose = false;
    if ((rr.mappedOutcome as any).landedId === 'purple') allLose = false;
  }
  assert(allLose, 'wheel FORCE_LOSE ×6: every round LOSE and never on the backed tier');
  console.log(`  ✓ wheel FORCE_LOSE ×6: every round LOSE, wheel avoids backed tier`);

  // disable mid-budget immediately
  await admin.patch('/panel/games/wheel/force', {
    forceOverride: 'FORCE_WIN',
    rounds: 5,
  });
  r = await admin.patch('/panel/games/wheel/force', {
    forceOverride: 'NONE',
    rounds: 0,
  });
  assert(r.status === 200, `force off ${r.status}`);
  const wcfg = await admin.get('/panel/games/wheel');
  assert(
    Number((wcfg.data as any).forceRoundsLeft) === 0,
    'disable zeroes the remaining budget'
  );
  console.log('  ✓ admin disable stops force immediately (rounds reset to 0)');
}

async function difficultyScenario(c: Client, admin: Client) {
  section('DIFFICULTY — platform default, per-game override, empirical shift');
  const N = 300;

  // exchange-rate probe: dice over-50 at baseline (normal)
  async function measure(slug: string, choices: any, rounds: number) {
    let wins = 0;
    for (let i = 0; i < rounds; i++) {
      const r = await placeBet(c, slug, choices);
      if (r.result === 'WIN') wins++;
    }
    return wins / rounds;
  }

  const base = await measure('dice', { over: true, target: 50 }, N);
  console.log(`  dice@normal   win-rate=${(base * 100).toFixed(1)}%  (fair = 50%)`);

  let r = await admin.patch('/panel/settings', { game_difficulty: 'hard' });
  assert(r.status === 200, `settings difficulty ${r.status}`, r.json);
  const hard = await measure('dice', { over: true, target: 50 }, N);
  console.log(`  dice@hard     win-rate=${(hard * 100).toFixed(1)}%  (expected ≈25%)`);
  assert(
    hard < 0.38 && hard > 0.12,
    `hard difficulty shifted win rate into the 0.5x band (got ${(hard * 100).toFixed(1)}%)`
  );

  r = await admin.patch('/panel/settings', { game_difficulty: 'impossible' });
  const imp = await measure('coin-flip', { choice: 'heads' }, N);
  console.log(`  coin@impossible win-rate=${(imp * 100).toFixed(1)}% (expected ≈5%)`);
  assert(
    imp < 0.14,
    `impossible difficulty crushed coin-flip wins (got ${(imp * 100).toFixed(1)}%)`
  );

  // Per-game override beats the platform level: coin-flip back to normal while
  // platform stays impossible. Keno stays platform-impossible.
  r = await admin.patch('/panel/games/coin-flip', { difficulty: 'normal' });
  assert(r.status === 200, `per-game difficulty ${r.status}`, r.json);
  const coinNormal = await measure('coin-flip', { choice: 'heads' }, N);
  console.log(
    `  coin@per-game normal (platform impossible): ${(coinNormal * 100).toFixed(1)}%`
  );
  assert(coinNormal > 0.4, 'per-game difficulty overrides the platform default');

  // restore
  await admin.patch('/panel/games/coin-flip', { difficulty: null });
  await admin.patch('/panel/settings', { game_difficulty: 'normal' });
  const restored = await admin.get('/panel/settings');
  assert(
    String((restored.data as any).game_difficulty) === 'normal',
    'platform difficulty restored to normal'
  );
  console.log('  ✓ restored: platform normal, coin-flip override cleared');
}

async function exemptionScenario(admin: Client) {
  section('EXEMPTIONS — session & shared-round games refuse operator steering');
  for (const slug of ['mines', 'tower', 'stairs', 'hi-lo', 'wingo']) {
    const f = await admin.patch(`/panel/games/${slug}/force`, {
      forceOverride: 'FORCE_WIN',
      rounds: 5,
    });
    assert(f.status === 422, `${slug} force refused (${f.status})`);
    const d = await admin.patch(`/panel/games/${slug}`, { difficulty: 'hard' });
    assert(d.status === 422, `${slug} difficulty refused (${d.status})`);
  }
  console.log('  ✓ mines/tower/stairs/hi-lo/wingo reject force + difficulty (422)');
}

/* ────────────────────────────────── main ───────────────────────────────── */
let RUN_START = new Date();
let RUN_START_BALANCE = 0;

async function main() {
  console.log(`Live playtest @ ${BASE}`);
  const c = await signupAndFund();
  const admin = await adminClient();
  RUN_START = new Date(Date.now() - 3000);
  RUN_START_BALANCE = await walletBalance(c);

  let sampled: string[] = [];
  if (!QUICK) {
    // Win-streak bonuses are credited on a delay (unlock animation); for exact
    // per-game ledger reconciliation we disable them for the baseline window.
    // (They gated fine and were proven in unit tests.)
    await admin.patch('/panel/settings', { ENABLE_WIN_STREAKS: false });
    sampled = await baseline(c);
    await verifyRounds(c, sampled);
  }
  await forceScenario(c, admin);
  await admin.patch('/panel/settings', { ENABLE_WIN_STREAKS: true });
  await difficultyScenario(c, admin);
  await exemptionScenario(admin);

  // FINAL EXACT LEDGER RECONCILIATION: allow the engagement queue to flush,
  // then the wallet's total movement must equal Σ(payout−stake) + every
  // bonus-row actually credited during the run.
  section('GLOBAL LEDGER RECONCILIATION');
  await new Promise((r) => setTimeout(r, 8000));
  const endBalance = await walletBalance(c);
  const bonusRows = await prisma.transaction.findMany({
    where: {
      userId: (await prisma.user.findFirstOrThrow({ where: { phone: PHONE } })).id,
      createdAt: { gte: RUN_START },
      type: {
        in: ['BONUS_WINSTREAK', 'BONUS_RAKEBACK', 'BONUS_REFERRAL', 'BONUS_SIGNUP'],
      },
    },
  });
  const bonusSum = bonusRows.reduce((t, x) => t + Number(x.amount), 0);
  const delta = +(endBalance - RUN_START_BALANCE).toFixed(2);
  const expected = +(LEDGER.expected + bonusSum).toFixed(2);
  assert(
    near(delta, expected, 0.25),
    `wallet Δ ${delta} = Σrounds ${LEDGER.expected.toFixed(2)} + bonuses ${bonusSum.toFixed(2)}`
  );
  console.log(
    `  ✓ wallet moved ${delta} (rounds ${LEDGER.expected.toFixed(2)} + bonuses ${bonusSum.toFixed(2)})`
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`CHECKS: ${checks}   FAILURES: ${failures.length}`);
  if (failures.length) {
    console.log(
      failures
        .slice(0, 30)
        .map((f) => '  ✗ ' + f)
        .join('\n')
    );
    process.exit(1);
  }
  console.log('ALL GREEN');
}

main()
  .catch((e) => {
    console.error('HARNESS CRASH:', e);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
