// e2e/gameui-smoke.mjs — server-render every game visual + bet panel (D-069)
// Uses esbuild (same transform as the Next build: automatic JSX runtime) to
// bundle each game module, then renders it server-side. Catches render-time crashes.
// Run: cd apps/web && node e2e/gameui-smoke.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const ALL_SLUGS = [
  'dice',
  'aviator',
  'crash-x',
  'plinko',
  'wingo',
  'mines',
  'wheel',
  'coin-flip',
  'tower',
  'stairs',
  'hi-lo',
  'limbo',
  'keno',
  'dragon-tiger',
  'roulette',
  'baccarat',
  'thimbles',
  'ring-of-fortune',
  'scratch-card',
  'lucky-number',
];

let pass = 0,
  fail = 0;
for (const slug of ALL_SLUGS) {
  try {
    const entry = `
      import { createElement } from 'react';
      import { renderToString } from 'react-dom/server';
      import { gameRegistry, gameLoaders } from './src/components/games/registry';
      (async () => {
        const slug = ${JSON.stringify(slug)};
        const registration = gameRegistry[slug];
        const mod = await gameLoaders[slug]();
        const props = { outcome: null, result: null, config: { minBet: 10, maxWinMultiplier: 100, configJson: {} }, choices: registration.defaultChoices ? registration.defaultChoices() : {}, setChoices: () => {}, eventPrefix: slug };
        let out = '';
        try { out = renderToString(createElement(mod.Visual, props)); if (out.length < 10) throw new Error('empty render'); }
        catch (e) { throw new Error('visual: ' + e.message); }
        try { renderToString(createElement(mod.BetPanel, { onBet: () => {}, minBet: 10, balance: 1000, isLoading: false, choices: props.choices, setChoices: () => {}, slug, config: props.config })); }
        catch (e) { throw new Error('betpanel: ' + e.message); }
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
    const bf = join(process.cwd(), 'e2e', '.bundle-smoke.cjs');
    writeFileSync(bf, res.outputFiles[0].text);
    const out = execSync(`node "${bf}"`, { cwd: process.cwd(), encoding: 'utf8' });
    if (!out.includes('OK')) throw new Error('no OK marker');
    pass++;
  } catch (e) {
    const msg = String(e.stdout || e.stderr || e.message || e);
    const line =
      msg
        .split('\n')
        .find(
          (l) =>
            l.includes('visual:') || l.includes('betpanel:') || l.includes('Error:')
        )
        ?.slice(0, 200) ?? msg.slice(0, 200);
    console.log(`FAIL ${slug}: ${line}`);
    fail++;
  }
}
console.log(`\nRESULT: ${pass}/${ALL_SLUGS.length} game UIs render OK`);
process.exit(fail ? 1 : 0);
