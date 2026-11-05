// Admin live-feed E2E (D-068): admin socket via ws-token → real bet → `admin:live-bet` event.
// Mirrors the winrate harness flow: login → csrf → signup → admin fund → bet.
import { io } from 'socket.io-client';
const API = process.env.API || 'http://localhost:4000';

const call = async (method, path, { body, auth = false, admin = false } = {}) => {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const login = await fetch(`${API}/api/v1/panel/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'superadmin',
      password: 'change-this-immediately',
    }),
  });
  const cookieMap = new Map(
    (login.headers.getSetCookie?.() ?? []).map((c) => [
      c.split('=')[0],
      c.split('=')[1].split(';')[0],
    ])
  );
  if (admin) {
    h['x-csrf-token'] = cookieMap.get('csrf_token') ?? '';
    h.Cookie = `admin_token=${cookieMap.get('admin_token') ?? ''}; csrf_token=${cookieMap.get('csrf_token') ?? ''}`;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, json };
};

// 1. fresh player
const phone = `+92${String(3000000000 + Math.floor(Math.random() * 999999999))}`;
const fp = { userAgent: 'e2e-feed', screenRes: '1x1', timezone: 'UTC', language: 'en' };
const signup = await call('POST', '/api/v1/auth/signup', {
  body: { phone, password: 'TestPass123!', fingerprint: fp },
});
console.log('signup:', signup.status);
if (signup.status !== 200) {
  console.log(JSON.stringify(signup.json).slice(0, 200));
  process.exit(1);
}
const { accessToken, user } = signup.json.data;

// 2. fund via admin (with cookie + csrf)
const fund = await call('POST', `/api/v1/panel/users/${user.id}/fund`, {
  admin: true,
  body: { walletType: 'real', amount: 1000, reason: 'admin feed test' },
});
console.log('fund:', fund.status, fund.json?.data?.real ?? fund.json?.message ?? '');

// 3. admin ws-token + socket
const wt = await call('GET', '/api/v1/panel/auth/ws-token', { admin: true });
const events = [];
const sock = io(API, {
  auth: { token: wt.json.data.token },
  transports: ['websocket'],
  reconnection: false,
});
sock.on('admin:live-bet', (pl) =>
  events.push([
    'live-bet',
    pl.kind,
    pl.game,
    pl.betAmount,
    pl.userId,
    pl.result,
    pl.payoutAmount,
  ])
);
sock.on('connect_error', (e) => events.push(['connect_error', e.message]));
await new Promise((r) => setTimeout(r, 800));

// 4. seed + bet
const seedJson = await (
  await fetch(`${API}/api/v1/provably-fair/active-seed`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
).json();
const seed = seedJson?.data?.clientSeed ?? 'admin-feed-test';
const bet = await fetch(`${API}/api/v1/games/coin-flip/bet`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    amount: 25,
    walletType: 'REAL',
    choices: { choice: 'heads' },
    clientSeed: seed,
  }),
});
const betJson = await bet.json();
console.log('bet:', bet.status, betJson?.data?.result ?? betJson?.message ?? '');
await new Promise((r) => setTimeout(r, 1500));

console.log(
  'admin events:',
  events.length ? events.map((e) => e.join('|')).join('  ||  ') : 'NONE ❌'
);
const ok =
  bet.status === 200 &&
  events.some((e) => e[0] === 'live-bet' && e[2] === 'coin-flip' && e[3] === 25);
sock.close();
process.exit(ok ? 0 : 1);
