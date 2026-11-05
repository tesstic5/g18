// Tier audit: does difficulty change WIN FREQUENCY ONLY, or does it leak into payouts?
// Throwaway measurement harness (not part of the test suite).
// Small N + per-game timing so a pathological handler is obvious.
import { ensureGamesRegistered, getGameHandler } from './src/engine/games/BaseGame';
import {
  DIFFICULTY_AWARE_SLUGS,
  DIFFICULTY_LEVELS,
  effectiveWinChance,
} from './src/engine/difficulty';
import type { DifficultyLevel } from './src/engine/difficulty';
import { defaultTiers } from './src/engine/games/WheelGame';
import { defaultRingTiers } from './src/engine/games/RingOfFortuneGame';

const N = 800;

function cfg(configJson: Record<string, unknown>, maxWin = 1000) {
  return {
    slug: 'x',
    maxWinMultiplier: maxWin,
    minBet: 1,
    baseRtp: 96,
    defaultPayout: 2,
    forceOverride: 'NONE',
    forceRoundsLeft: 0,
    configJson,
  } as never;
}

function choicesFor(slug: string): Record<string, unknown> {
  switch (slug) {
    case 'dice':
      return { over: true, target: 50 };
    case 'limbo':
      return { target: 2 };
    case 'coin-flip':
      return { choice: 'heads' };
    case 'thimbles':
      return { cup: 0 };
    case 'wheel':
      return { tier: defaultTiers()[0]!.id };
    case 'ring-of-fortune':
      return { tier: defaultRingTiers()[0]!.id };
    case 'roulette':
      return { bet: { type: 'red' } };
    case 'keno':
      return { picks: [1, 2, 3, 4, 5] };
    case 'plinko':
      return { risk: 'medium', rows: 12, balls: 1 };
    case 'lucky-number':
      return { betMin: 1, betMax: 10 };
    case 'dragon-tiger':
      return { bet: 'dragon' };
    case 'baccarat':
      return { bet: 'player' };
    case 'scratch-card':
      return {};
    default:
      return {};
  }
}

const CONFIGS: Record<string, Record<string, unknown>> = {
  keno: {
    grid_size: 40,
    draw_count: 20,
    max_picks: 10,
    payout_tables: { '5_picks': { '3': 2, '4': 10, '5': 50 } },
  },
  thimbles: { cups: 3 },
  'lucky-number': { min: 1, max: 100 },
};

await ensureGamesRegistered();

const problems: string[] = [];
console.log(
  'game'.padEnd(17),
  'tier'.padEnd(11),
  'winRate'.padStart(8),
  'RTP%'.padStart(9),
  'meanPay|win'.padStart(12),
  'ms'.padStart(6)
);

for (const slug of DIFFICULTY_AWARE_SLUGS) {
  const t0 = Date.now();
  const config = cfg(CONFIGS[slug] ?? {});
  const choices = choicesFor(slug);
  const handler = getGameHandler(slug);
  const pFair = handler.fairWinChance(choices, config)!;
  const rows: {
    tier: DifficultyLevel;
    winRate: number;
    rtp: number;
    meanWinPay: number;
  }[] = [];

  for (const tier of DIFFICULTY_LEVELS) {
    const pEff = effectiveWinChance(pFair, tier);
    let wins = 0,
      sumPay = 0,
      sumWinPay = 0;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const r = await handler.resolve({
        isWin: u < pEff,
        rawOutcome: u,
        config,
        choices,
        forceMode: 'NONE',
        difficulty: tier as DifficultyLevel,
      });
      sumPay += r.payoutMultiplier;
      if (r.payoutMultiplier > 1) {
        wins++;
        sumWinPay += r.payoutMultiplier;
      }
    }
    const row = {
      tier,
      winRate: wins / N,
      rtp: (sumPay / N) * 100,
      meanWinPay: wins ? sumWinPay / wins : 0,
    };
    rows.push(row);
    console.log(
      slug.padEnd(17),
      tier.padEnd(11),
      row.winRate.toFixed(4).padStart(8),
      row.rtp.toFixed(2).padStart(9),
      row.meanWinPay.toFixed(4).padStart(12),
      String(Date.now() - t0).padStart(6)
    );
  }

  const pay = rows.map((r) => r.meanWinPay).filter((v) => v > 0);
  if (pay.length >= 2) {
    const lo = Math.min(...pay),
      hi = Math.max(...pay);
    const spread = hi > 0 ? (hi - lo) / lo : 0;
    if (spread > 0.02) {
      problems.push(
        `${slug}: mean payout|win varies ${(spread * 100).toFixed(1)}% (${rows.map((r) => `${r.tier}=${r.meanWinPay.toFixed(3)}`).join(', ')})`
      );
    }
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.winRate > rows[i - 1]!.winRate + 0.02) {
      problems.push(
        `${slug}: winRate rose ${rows[i - 1]!.tier}->${rows[i]!.tier} (${rows[i - 1]!.winRate.toFixed(4)} -> ${rows[i]!.winRate.toFixed(4)})`
      );
    }
  }
}

console.log('='.repeat(70));
if (problems.length === 0) {
  console.log(
    'PASS: win frequency scales; payout given a win is tier-invariant (<=2% spread)'
  );
} else {
  console.log(`FAIL: ${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
}
