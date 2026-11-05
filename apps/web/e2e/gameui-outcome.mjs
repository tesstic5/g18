// e2e/gameui-outcome.mjs — render every game visual WITH outcome data (D-069)
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const OUTCOMES = {
  dice: { resultNumber: 73.5 },
  aviator: { crashPoint: 2.4 },
  'crash-x': { crashPoint: 3.1 },
  plinko: {
    bucketIndex: 8,
    multipliers: [0.5, 0.7, 1, 1.5, 2, 3, 5, 10, 24, 130, 1000, 2, 0.5],
  },
  wingo: { number: 7, color: 'red' },
  mines: { isMine: true, minePositions: [3, 9, 17], currentMultiplier: 1.5 },
  wheel: {
    segmentIndex: 3,
    segments: [
      { label: '0×', multiplier: 0 },
      { label: '1.5×', multiplier: 1.5 },
      { label: '2×', multiplier: 2 },
      { label: '3×', multiplier: 3 },
      { label: '5×', multiplier: 5 },
      { label: '10×', multiplier: 10 },
      { label: '25×', multiplier: 25 },
    ],
  },
  'coin-flip': { side: 'tails', multiplier: 1.95 },
  tower: { safe: true, trapPositions: [1, 3] },
  stairs: { safe: true },
  'hi-lo': {
    current: '7',
    next: '9',
    suit: '♥',
    win: true,
    probability: 48,
    multiplier: 2.1,
  },
  limbo: { result: 3.2 },
  keno: { drawn: [4, 12, 22, 33, 40], matches: 2, picks: [4, 12], multiplier: 2.5 },
  'dragon-tiger': {
    dragon: 'K♠',
    tiger: '7♦',
    outcome: 'dragon',
    win: true,
    multiplier: 1.95,
  },
  roulette: {
    pocket: 17,
    color: 'black',
    bet: { type: 'red' },
    win: false,
    multiplier: 0,
  },
  baccarat: {
    playerCards: [5, 8],
    bankerCards: [3, 9],
    playerPoint: 3,
    bankerPoint: 2,
    outcome: 'player',
    win: true,
    multiplier: 1.95,
  },
  thimbles: { ballCup: 1 },
  'ring-of-fortune': {
    segmentIndex: 2,
    label: '5×',
    multiplier: 5,
    isSpecial: false,
    win: true,
  },
  'scratch-card': {
    grid: ['💎', '💎', '💎', '⭐', '7', '⭐', '🍀', '7', '🍀'],
    winLine: ['💎', '💎', '💎'],
    win: true,
  },
  'lucky-number': { result: 55 },
};

const SLUGS = Object.keys(OUTCOMES);
let pass = 0,
  fail = 0;
for (const slug of SLUGS) {
  try {
    const entry = `
      import { createElement } from 'react';
      import { renderToString } from 'react-dom/server';
      import { gameRegistry, gameLoaders } from './src/components/games/registry';
      (async () => {
        const slug = ${JSON.stringify(slug)};
        const registration = gameRegistry[slug];
        const mod = await gameLoaders[slug]();
        const outcome = ${JSON.stringify(OUTCOMES[slug])};
        const choices = registration.defaultChoices ? registration.defaultChoices() : {};
        const props = { outcome, result: ${JSON.stringify(slug === 'mines' ? 'LOSE' : slug === 'aviator' ? 'BUST' : slug === 'crash-x' ? 'BUST' : 'WIN')}, config: { minBet: 10, maxWinMultiplier: 100, configJson: {} }, choices, setChoices: () => {}, eventPrefix: slug };
        let out = '';
        try { out = renderToString(createElement(mod.Visual, props)); if (out.length < 10) throw new Error('empty render'); }
        catch (e) { throw new Error('visual: ' + e.message); }
        console.log('OK ' + slug);
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const res = esbuild.buildSync({
      stdin: {
        contents: entry,
        resolveDir: process.cwd(),
        sourcefile: 'smoke.tsx',
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: [
        'react',
        'react-dom',
        'react-dom/server',
        'socket.io-client',
        'howler',
        'zustand',
        '@tanstack/react-query',
      ],
      logLevel: 'silent',
    });
    const bf = join(process.cwd(), 'e2e', '.bundle-outcome.cjs');
    writeFileSync(bf, res.outputFiles[0].text);
    const out = execSync(`node "${bf}"`, { cwd: process.cwd(), encoding: 'utf8' });
    if (!out.includes('OK')) throw new Error('no OK');
    pass++;
  } catch (e) {
    const msg = String(e.stdout || e.stderr || e.message || e);
    const line =
      msg
        .split('\n')
        .find((l) => l.includes('visual:') || l.includes('Error:'))
        ?.slice(0, 200) ?? msg.slice(0, 200);
    console.log(`FAIL ${slug}: ${line}`);
    fail++;
  }
}
console.log(`\nOUTCOME-RENDER RESULT: ${pass}/${SLUGS.length} OK`);
process.exit(fail ? 1 : 0);
