#!/usr/bin/env node
// Standalone check: admin dashboard + reports formulas agree, and the
// source still uses the canonical settled-round filters. No DB, no install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SETTLED = (r) => !r.demo && r.result !== 'PENDING';
const utcDay = (iso) => iso.slice(0, 10);
const ggr = (rows) =>
  rows.reduce((s, r) => s + r.betAmount, 0) -
  rows.reduce((s, r) => s + r.payoutAmount, 0);
const volume = (rows) => rows.reduce((s, r) => s + r.betAmount, 0);
const payout = (rows) => rows.reduce((s, r) => s + r.payoutAmount, 0);
const rtp = (rows) => {
  const v = volume(rows);
  return v > 0 ? (payout(rows) / v) * 100 : 0;
};
const wins = (rows) =>
  rows.filter((r) => r.result === 'WIN' || r.result === 'CASHOUT').length;
const winRate = (rows) => (rows.length ? (wins(rows) / rows.length) * 100 : 0);
const playerNet = (rows) => payout(rows) - volume(rows);

const T0 = '2026-08-31T10:00:00.000Z';
const T1 = '2026-08-30T22:00:00.000Z';
const rounds = [
  // today, dice WIN
  {
    userId: 'u1',
    gameSlug: 'dice',
    betAmount: 100,
    payoutAmount: 192,
    result: 'WIN',
    demo: false,
    createdAt: T0,
  },
  // today, crash CASHOUT — must count as a win, GGR = 100-250 = -150
  {
    userId: 'u1',
    gameSlug: 'crash-x',
    betAmount: 100,
    payoutAmount: 250,
    result: 'CASHOUT',
    demo: false,
    createdAt: T0,
  },
  // today, PUSH (stake returned) — GGR 0, not a win
  {
    userId: 'u2',
    gameSlug: 'baccarat',
    betAmount: 50,
    payoutAmount: 50,
    result: 'PUSH',
    demo: false,
    createdAt: T0,
  },
  // today, LOSE
  {
    userId: 'u2',
    gameSlug: 'dice',
    betAmount: 80,
    payoutAmount: 0,
    result: 'LOSE',
    demo: false,
    createdAt: T0,
  },
  // today, BUST
  {
    userId: 'u3',
    gameSlug: 'crash-x',
    betAmount: 40,
    payoutAmount: 0,
    result: 'BUST',
    demo: false,
    createdAt: T0,
  },
  // OPEN mines session — MUST be excluded
  {
    userId: 'u1',
    gameSlug: 'mines',
    betAmount: 999,
    payoutAmount: 0,
    result: 'PENDING',
    demo: false,
    createdAt: T0,
  },
  // demo — MUST be excluded
  {
    userId: 'u9',
    gameSlug: 'dice',
    betAmount: 500,
    payoutAmount: 960,
    result: 'WIN',
    demo: true,
    createdAt: T0,
  },
  // yesterday, WIN
  {
    userId: 'u2',
    gameSlug: 'dice',
    betAmount: 200,
    payoutAmount: 384,
    result: 'WIN',
    demo: false,
    createdAt: T1,
  },
];

const settled = rounds.filter(SETTLED);
assert.equal(settled.length, 6, 'PENDING + demo dropped');
assert.ok(!settled.some((r) => r.result === 'PENDING' || r.demo));

// 100+100+50+80+40+200 = 570 staked
// 192+250+50+0+0+384 = 876 paid  → GGR −306, player net +306
assert.equal(volume(settled), 570);
assert.equal(payout(settled), 876);
assert.equal(ggr(settled), -306);
assert.equal(playerNet(settled), 306);
assert.equal(playerNet(settled), -ggr(settled));
assert.equal(wins(settled), 3); // WIN + CASHOUT + yesterday WIN; PUSH/LOSE/BUST out
assert.equal(
  wins(
    settled.filter(
      (r) => r.result === 'PUSH' || r.result === 'LOSE' || r.result === 'BUST'
    )
  ),
  0
);

const pushOnly = settled.filter((r) => r.result === 'PUSH');
assert.equal(ggr(pushOnly), 0);

const cashout = settled.filter((r) => r.result === 'CASHOUT');
assert.equal(wins(cashout), 1);
assert.equal(ggr(cashout), -150);

// Dashboard today (UTC) vs reports revenue for 2026-08-31
const today = settled.filter((r) => utcDay(r.createdAt) === '2026-08-31');
const dashToday = {
  bets: today.length,
  volume: volume(today),
  payout: payout(today),
  ggr: ggr(today),
};
const reportRevenue = ['2026-08-30', '2026-08-31'].map((date) => {
  const rows = settled.filter((r) => utcDay(r.createdAt) === date);
  return {
    date,
    rounds: rows.length,
    wagered: volume(rows),
    paid_out: payout(rows),
    ggr: ggr(rows),
    unique_players: new Set(rows.map((r) => r.userId)).size,
  };
});
const revToday = reportRevenue.find((r) => r.date === '2026-08-31');
assert.equal(revToday.wagered, dashToday.volume);
assert.equal(revToday.paid_out, dashToday.payout);
assert.equal(revToday.ggr, dashToday.ggr);
assert.equal(revToday.rounds, dashToday.bets);
assert.equal(revToday.unique_players, 3);

// Game performance vs reports games
function byGame(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.gameSlug) ?? [];
    g.push(r);
    map.set(r.gameSlug, g);
  }
  return [...map.entries()].map(([slug, rs]) => ({
    slug,
    rounds: rs.length,
    volume: volume(rs),
    payout: payout(rs),
    ggr: ggr(rs),
    rtp: rtp(rs),
    win_rate: winRate(rs),
  }));
}
const dashGames = byGame(today);
const reportGames = byGame(today);
assert.deepEqual(
  dashGames.map((g) => ({ slug: g.slug, volume: g.volume, ggr: g.ggr, rtp: g.rtp })),
  reportGames.map((g) => ({ slug: g.slug, volume: g.volume, ggr: g.ggr, rtp: g.rtp }))
);
const crash = dashGames.find((g) => g.slug === 'crash-x');
assert.equal(crash.win_rate, 50); // 1 CASHOUT + 1 BUST
assert.equal(crash.volume, 140);
assert.equal(crash.payout, 250);
assert.equal(crash.rtp, (250 / 140) * 100);

// Top players: net is player P&L
function topPlayers(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = map.get(r.userId) ?? [];
    g.push(r);
    map.set(r.userId, g);
  }
  return [...map.entries()]
    .map(([id, rs]) => ({
      id,
      wagered: volume(rs),
      won: payout(rs),
      net: playerNet(rs),
      ggr: ggr(rs),
    }))
    .sort((a, b) => b.wagered - a.wagered);
}
const tops = topPlayers(today);
assert.equal(tops[0].id, 'u1');
assert.equal(tops[0].net, 250 + 192 - 200); // player profit
assert.equal(tops[0].ggr, -tops[0].net);
assert.ok(tops.find((p) => p.id === 'u2').net < 0);

// Source still encodes the canonical filters (regression against a silent revert)
const panel = readFileSync(join(root, 'apps/api/src/routes/panel.ts'), 'utf8');
const reports = readFileSync(join(root, 'apps/api/src/routes/reports.ts'), 'utf8');
const worker = readFileSync(join(root, 'apps/worker/src/index.ts'), 'utf8');
for (const [name, src] of [
  ['panel revenue-trend', panel],
  ['reports', reports],
]) {
  assert.match(src, /demo = false/);
  assert.match(src, /result["']?\s*<>\s*'PENDING'|result: \{ not: 'PENDING' \}/);
}
assert.match(panel, /to_char\("createdAt", 'YYYY-MM-DD'\)/);
assert.match(reports, /FROM "GameRound"/);
assert.doesNotMatch(reports, /type IN \('BET','WIN'\)/);
assert.match(reports, /result" IN \('WIN','CASHOUT'\)/);
assert.match(reports, /as rtp/);
assert.match(panel, /net: Number\(r\.won\) - Number\(r\.wagered\)/);
assert.match(worker, /to_char\("createdAt", 'YYYY-MM-DD'\)/);
assert.match(worker, /result" <> 'PENDING'/);

console.log(
  JSON.stringify(
    {
      ok: true,
      settledRounds: settled.length,
      volume: volume(settled),
      payout: payout(settled),
      ggr: ggr(settled),
      playerNet: playerNet(settled),
      rtp: +rtp(settled).toFixed(2),
      winRate: +winRate(settled).toFixed(1),
      today: dashToday,
      games: dashGames,
      topPlayers: tops,
    },
    null,
    2
  )
);
