// e2e/wingo-ui.mjs (v2 — retargeted to the current WinGo client UI)
// Headless-browser checks against the LIVE rig (web :3000 production build,
// api :4000). Auth: real signup + seeded funds + the login FORM (typing in
// national format, like a user). SPA navigation is used to keep the in-memory
// session (a hard reload clears the auth store — same as a real tab).
//
// Verified DOM facts (traced live 2026-08-26):
//   time tabs: WinGo30sec | WinGo1Min | WinGo3Min | WinGo5Min
//   board: Green / Violet / Red, 0-9, Random, X1 X5 X10 X20 X50 X100, Big/Small
//   lock window (last 5s + draw): board dims, "Betting closed" overlay shows
//   bet sheet: "WinGo 30sec — Green", Amount 10/100/1000, Quantity X1..X100,
//     "Total Rs10.00  win Rs24.00" (2.4× preview), checkbox "I agree to the
//     pre-sale rules" (checked by default), confirm "Total amount Rs10.00"
//   guests see "Log in to play Win Go for real money." + Log in / Sign up CTA
import { existsSync } from 'node:fs';

const API = process.env.API || 'http://localhost:4000';
const WEB = process.env.WEB || 'http://localhost:3000';
const results = [];
const pass = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── setup: user + funds ────────────────────────────────────────────────────
const phone = `+923${String(100000000 + Math.floor(Math.random() * 899999999))}`;
const national = `0${phone.slice(3)}`;
const fp = {
  userAgent: 'e2e-wingo-ui',
  screenRes: '1x1',
  timezone: 'UTC',
  language: 'en',
};
const su = await fetch(`${API}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, password: 'TestPass123!', fingerprint: fp }),
});
const sj = await su.json().catch(() => null);
if (!sj?.data?.accessToken) {
  console.log('signup failed:', JSON.stringify(sj).slice(0, 160));
  process.exit(1);
}
const uid = sj.data.user.id;
{
  const al = await fetch(`${API}/api/v1/panel/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'superadmin',
      password: 'change-this-immediately',
    }),
  });
  const ac = (al.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const acs =
    (al.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith('csrf_token='))
      ?.split('=')[1]
      ?.split(';')[0] ?? '';
  const fund = await fetch(`${API}/api/v1/panel/users/${uid}/fund`, {
    method: 'POST',
    headers: { Cookie: ac, 'X-CSRF-Token': acs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletType: 'real', amount: 5000 }),
  });
  pass(
    'probe user signup + funded ₨5,000',
    fund.status === 200,
    `status ${fund.status}`
  );
}

const chrome =
  process.env.CHROME_BIN ||
  ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(
    existsSync
  );
if (!chrome) throw new Error('Set CHROME_BIN to a Chromium/Chrome executable');

const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: chrome,
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
page.on('console', (m) => {
  if (
    m.type() === 'error' &&
    !m.text().includes('401') &&
    !m.text().includes('vibrate') // headless blocks navigator.vibrate — benign
  )
    consoleErrors.push(m.text().slice(0, 160));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// normalize the ₨ glyph to Rs so regexes are currency-glyph-agnostic
const bodyText = () =>
  page.evaluate(() => (document.body.textContent ?? '').replace(/₨/g, 'Rs'));
const tapButton = async (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === t
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, text);

try {
  // ── 1. guest sees the board + a login CTA (auth gate visible) ─────────────
  await page.goto(`${WEB}/games/wingo`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2500);
  {
    const t = await bodyText();
    pass(
      'guest: board renders (tabs, How to play, targets)',
      t.includes('WinGo30sec') && t.includes('WinGo5Min') && t.includes('How to play')
    );
    pass(
      'guest: "Log in to play" CTA shown (real-money gate)',
      t.includes('Log in to play')
    );
  }

  // ── 2. REAL login through the form (national format like a user types) ────
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[placeholder*="1234"]', national, { delay: 6 });
  await page.type('input[type=password]', 'TestPass123!', { delay: 6 });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => /sign in/i.test(b.textContent ?? ''))
      ?.click();
  });
  let authed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (!page.url().includes('/login')) {
      authed = true;
      break;
    }
  }
  pass('login form redirects out of /login (real session)', authed, page.url());

  // SPA-navigate to the game (hard reload clears the in-memory auth store)
  await page.evaluate(() => document.querySelector('a[href="/games/wingo"]')?.click());
  await sleep(4000);
  pass(
    'navigated to WinGo via SPA link',
    page.url().includes('/games/wingo'),
    page.url()
  );
  {
    const w = (await bodyText()).match(/Rs[\d,.]+/)?.[0] ?? 'none';
    pass(
      'wallet card shows the funded balance (₨5,000)',
      w.replace(/[,.]/g, '').includes('500000'),
      w
    );
  }

  // ── 3. structural checks ──────────────────────────────────────────────────
  // Note: view/time tabs are not necessarily <button> elements — assert against
  // whitespace-stripped page text instead of per-button labels.
  {
    const flat = (await bodyText()).replace(/\s+/g, '');
    pass(
      'time tabs: WinGo30sec / WinGo1Min / WinGo3Min / WinGo5Min',
      ['WinGo30sec', 'WinGo1Min', 'WinGo3Min', 'WinGo5Min'].every((x) =>
        flat.includes(x)
      )
    );
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .map((b) => (b.textContent ?? '').replace(/\s+/g, ''))
        .filter(Boolean)
    );
    pass(
      'targets: Green / Violet / Red buttons',
      ['Green', 'Violet', 'Red'].every((x) => btns.includes(x))
    );
    pass(
      'numbers 0-9 + Random + Big/Small + multipliers X1..X100',
      ['0', '9', 'Random', 'Big', 'Small', 'X1', 'X5', 'X100'].every((x) =>
        btns.includes(x)
      )
    );
    pass(
      'view tabs: Game history / Chart / My history',
      ['Gamehistory', 'Chart', 'Myhistory'].every((x) => flat.includes(x))
    );
  }
  {
    const t = await bodyText();
    pass(
      'header: Time remaining clock + period id',
      /Time remaining/.test(t) && /\d{15,}/.test(t),
      t.match(/\d{15,}/)?.[0] ?? ''
    );
    pass(
      'stats labels: Missing / Avg missing / Frequency / Max consecutive',
      ['Missing', 'Avg missing', 'Frequency', 'Max consecutive'].every((x) =>
        t.includes(x)
      )
    );
  }

  // ── 4. tap Green in an OPEN window → bet sheet ────────────────────────────
  let opened = false;
  for (let i = 0; i < 60 && !opened; i++) {
    await tapButton('Green');
    await sleep(800);
    const t = await bodyText();
    if (t.includes('I agree to the pre-sale rules')) opened = true;
  }
  pass('tapping Green in an open window opens the bet sheet', opened);
  {
    const t = await bodyText();
    pass(
      'sheet header mirrors the choice (WinGo 30sec — Green)',
      t.includes('WinGo 30sec — Green')
    );
    pass(
      'sheet: Amount chips 10 / 100 / 1000 + Quantity X1..X100',
      ['10', '100', '1000', 'X1', 'X5', 'X10', 'X20', 'X50', 'X100'].every((x) =>
        t.includes(x)
      )
    );
    pass(
      'sheet: "I agree to the pre-sale rules" checkbox',
      t.includes('I agree to the pre-sale rules')
    );
    pass(
      'payout preview: Total Rs10.00 + win Rs24.00 (2.4× server odds)',
      /Rs\s*10\.00/.test(t) && /win\s*Rs\s*24\.00/.test(t),
      t.match(/Total\s*Rs[\d,.]+.*?win\s*Rs[\d,.]+/s)?.[0]?.replace(/\s+/g, ' ') ?? ''
    );
  }

  // The bet sheet = SMALLEST div containing BOTH the terms line and the
  // confirm label (footer-grid-only containers contain just "Total amount").
  const pickInSheet = async (label) =>
    page.evaluate((l) => {
      const norm = (s) => (s ?? '').replace(/₨/g, 'Rs');
      const sheet = [...document.querySelectorAll('div')]
        .filter((e) => {
          const t = norm(e.textContent);
          return (
            /Total amount Rs/.test(t) && t.includes('I agree to the pre-sale rules')
          );
        })
        .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
      if (!sheet) return false;
      const b = [...sheet.querySelectorAll('button')].find(
        (x) => (x.textContent ?? '').trim() === l
      );
      if (b) {
        b.click();
        return true;
      }
      return false;
    }, label);
  const clickSheetCheckbox = async () =>
    page.evaluate(() => {
      const norm = (s) => (s ?? '').replace(/₨/g, 'Rs');
      const sheet = [...document.querySelectorAll('div')]
        .filter((e) => {
          const t = norm(e.textContent);
          return (
            /Total amount Rs/.test(t) && t.includes('I agree to the pre-sale rules')
          );
        })
        .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
      const cb = sheet?.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.click();
        return true;
      }
      return false;
    });

  await pickInSheet('100');
  await pickInSheet('X5');
  await sleep(400);
  {
    const t = await bodyText();
    pass(
      'total math: 100 × X5 → Total Rs500.00 (win Rs1,200.00)',
      /Rs\s*500\.00/.test(t) && /win\s*Rs\s*1,200\.00|win\s*Rs\s*1200\.00/.test(t),
      t.match(/Total\s*Rs[\d,.]+.*?win\s*Rs[\d,.]+/s)?.[0]?.replace(/\s+/g, ' ') ?? ''
    );
  }

  // terms gate: checkbox starts CHECKED → uncheck disables confirm
  const confirmState = async () =>
    page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /Total amount/.test(x.textContent ?? '')
      );
      return b
        ? {
            disabled: b.disabled,
            label: (b.textContent ?? '').trim().replace(/₨/g, 'Rs'),
          }
        : null;
    });
  {
    const before = await confirmState();
    pass(
      'confirm shows mirrored total ("Total amount Rs500.00")',
      /Total amount Rs\s*500\.00/.test(before?.label ?? ''),
      before?.label ?? ''
    );
    pass('terms checkbox found in sheet', await clickSheetCheckbox());
    await sleep(300);
    const off = await confirmState();
    await clickSheetCheckbox(); // re-check
    await sleep(300);
    const on = await confirmState();
    pass(
      'terms gate: confirm disabled when rules unchecked, re-enables when checked',
      off?.disabled === true && on?.disabled === false,
      `off=${off?.disabled} on=${on?.disabled}`
    );
  }

  // view tabs (Game history / Chart / My history) are not <button>s — generic tapper
  const tapTab = async (text) =>
    page.evaluate((t) => {
      for (const sel of ['button', 'a', '[role="tab"]', 'div', 'span', 'li']) {
        for (const el of document.querySelectorAll(sel)) {
          if ((el.textContent ?? '').trim() === t) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, text);

  // ── 5. place the bet → sheet closes, wallet debits ₨500 on the page ────────
  const walletBefore = (await bodyText()).match(/Rs[\d,.]+/)?.[0] ?? '';
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((x) => /Total amount/.test(x.textContent ?? ''))
      ?.click();
  });
  // sheet should close promptly; balance refresh rides the wallet sync/socket.
  // ALSO watch for the live "MY BETS  Green · Rs500" pill — it clears the
  // moment the round settles, so detection is folded into the close loop.
  // (traced ground truth: `MY BETS  Green · Rs10` pill, amounts w/o decimals)
  let sheetGone = false;
  let chipOk = false;
  for (let i = 0; i < 12 && !sheetGone; i++) {
    await sleep(500);
    const t = await bodyText();
    sheetGone = !t.includes('I agree to the pre-sale rules');
    if (!chipOk)
      chipOk = /MY BETS/i.test(t) && /Green\s*[·•-]\s*Rs\s*500(?!\d)/.test(t);
  }
  for (let i = 0; i < 25 && !chipOk; i++) {
    if (i) await sleep(400);
    const t = await bodyText();
    chipOk = /MY BETS/i.test(t) && /Green\s*[·•-]\s*Rs\s*500(?!\d)/.test(t);
  }
  pass('live "MY BETS" chip shows the placed bet (Green · Rs500)', chipOk);

  {
    // any debit or settlement moves the card — poll past the full round cycle
    let wAfter = '';
    for (let i = 0; i < 45; i++) {
      wAfter = (await bodyText()).match(/Rs[\d,.]+/)?.[0] ?? '';
      if (wAfter && wAfter !== walletBefore) break;
      await sleep(1000);
    }
    const num = (s) => Number(s.replace(/\D+/g, ''));
    const diff = num(wAfter) - num(walletBefore);
    // two legal flows: draw not yet settled (−₨500.00 debit only) or our Green
    // bet settled at 2.4× inside the poll window (−500 + 1200 = +₨700.00)
    pass('bet placed: sheet closes after confirm', sheetGone);
    pass(
      'server-side bet flow: stake debited (−₨500) or win settled (+₨700)',
      diff === -50000 || diff === 70000,
      `${walletBefore} → ${wAfter} (Δ ${diff / 100})`
    );
  }

  // ── 6b. My history tab opens ───────────────────────────────────────────────
  {
    pass('My history tab clickable', await tapTab('My history'));
  }

  // ── 7. Chart tab: 10×10 trend grid ─────────────────────────────────────────
  {
    pass('Chart tab clickable', await tapTab('Chart'));
    await sleep(1500);
    const cells = await page.evaluate(() => {
      // the 10×10 period grid: number circles stacked in rows of 10
      const nums = [...document.querySelectorAll('div,a,span,button')].filter((e) =>
        /^[0-9]$/.test((e.textContent ?? '').trim())
      );
      return nums.length;
    });
    pass(
      'Chart tab renders the trend grid (≥100 number cells)',
      cells >= 100,
      `${cells} cells`
    );
  }

  // ── 8. lock window: board shows "Betting closed", taps are inert ───────────
  // (a round can roll between poll and tap; only rule on windows that persist
  // through the tap)
  {
    let lockedSeen = false;
    let inertDenied = null; // null = not yet ruled
    const deadline = Date.now() + 160000;
    while (Date.now() < deadline && (inertDenied === null || !lockedSeen)) {
      const t1 = await bodyText();
      if (!t1.includes('Betting closed')) {
        await sleep(1200);
        continue;
      }
      lockedSeen = true;
      await tapButton('Red');
      await sleep(500);
      const t2 = await bodyText();
      if (!t2.includes('Betting closed')) continue; // round rolled mid-tap — retry
      inertDenied = !t2.includes('I agree to the pre-sale rules'); // sheet stayed closed?
      // don't leave a sheet dangling if one did open
      await tapButton('Cancel');
    }
    pass('last-5s lock: "Betting closed" overlay/board-dim shown', lockedSeen);
    pass(
      'last-5s lock: tapping targets does NOT open the sheet',
      inertDenied === true,
      inertDenied === null ? 'never persisted through a tap' : ''
    );
  }

  pass(
    'no page errors / console errors',
    consoleErrors.length === 0,
    consoleErrors[0] ?? 'clean'
  );
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\nWINGO UI E2E RESULT: ${results.length - failed.length}/${results.length} passed`
);
process.exit(failed.length ? 1 : 0);
