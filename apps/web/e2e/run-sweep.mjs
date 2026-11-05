// e2e/run-sweep.mjs — full live-probe sweep runner (v1.4.3+).
// Runs every probe sequentially against the LOCAL rig, resetting the
// sandbox rate-limit counters between probes so back-to-back signups don't
// trip the product's 10/h signup cap (probes create dozens of test users).
//
// Usage:  node e2e/run-sweep.mjs            # all probes
//         node e2e/run-sweep.mjs wingo      # only paths matching 'wingo'
// Must run from apps/web (gameui probes resolve ./src).
import { execFileSync } from 'node:child_process';
import { resetRateLimits } from './lib/reset-rate-limits.mjs';

const ALL = [
  'full-e2e',
  'flow-probe',
  'wave3',
  'security.test',
  'support-flow',
  'admin-notify-live',
  'adminfeed-test',
  'deposit-notify',
  'deposit-relay',
  'games-visibility-hot-v140',
  'money-limits-v141',
  'bonus-claim.test',
  'bonus-audit-v141',
  'plinko-retune-v139',
  'balance-coerce.test',
  'render-loop.test',
  'winrate',
  'crash-v2-math',
  'crash-my-result',
  'gamepage-crash',
  'aviator-full-play',
  'session-games',
  'card-games',
  'gameui-smoke',
  'gameui-outcome',
  'wingo-rounds',
  'wingo-full-play',
  'wingo-difficulty',
  // flap probes last — they cut Redis for seconds
  'wingo-flap-probe',
  'flap-probe',
  // browser-required probes are skipped unless CHROME_BIN is set
  ...(process.env.CHROME_BIN ? ['accessibility', 'wingo-ui'] : []),
];

const filter = process.argv[2];
const probes = filter ? ALL.filter((p) => p.includes(filter)) : ALL;
if (!process.env.CHROME_BIN && !filter)
  console.log(
    'ℹ  CHROME_BIN unset — skipping accessibility + wingo-ui (need Chrome)\n'
  );

let pass = 0,
  fail = 0;
const failures = [];
for (const p of probes) {
  await resetRateLimits().catch(() => {});
  try {
    execFileSync('node', [`e2e/${p}.mjs`], { stdio: 'inherit', timeout: 15 * 60_000 });
    console.log(`✅ ${p}\n`);
    pass++;
  } catch {
    console.log(`❌ ${p}\n`);
    fail++;
    failures.push(p);
  }
}
console.log(`\n═══ SWEEP: ${pass} green, ${fail} red ═══`);
if (failures.length) console.log('red probes:', failures.join(', '));
process.exit(fail ? 1 : 0);
