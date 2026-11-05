import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const chrome =
  process.env.CHROME_BIN ||
  ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(
    existsSync
  );
if (!chrome) throw new Error('Set CHROME_BIN to a Chromium/Chrome executable');
const web = process.env.WEB || 'http://127.0.0.1:3000';
const routes = [
  '/',
  '/login',
  '/signup',
  '/games',
  '/games/dice',
  '/wallet',
  '/panel/login',
];
const browser = await puppeteer.launch({
  executablePath: chrome,
  protocolTimeout: 300_000, // axe on animated game pages can be slow in this sandbox
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  for (const route of routes) {
    await page.goto(`${web}${route}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.addScriptTag({ path: axePath });
    let result;
    try {
      result = await page.evaluate(async () => {
        const axe = window.axe;
        return axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        });
      });
    } catch (e) {
      console.log(`❌ ${route}: audit error — ${String(e).slice(0, 90)}`);
      failed = true;
      continue;
    }
    const serious = result.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact)
    );
    console.log(
      `${serious.length ? '❌' : '✅'} ${route}: ${serious.length} serious/critical violations`
    );
    for (const violation of serious) {
      console.log(
        `  ${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`
      );
    }
    if (serious.length) failed = true;
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
