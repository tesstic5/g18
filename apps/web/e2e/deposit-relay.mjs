// Live relay-upload verification: POST /deposits/upload (correction #8).
// Login → multipart proof upload through the API → object lands in MinIO.
// Runs against the local rig: PG :55432, Redis :56379, MinIO :59000, API :4000.
import { createHash } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:4000/api/v1';
const PHONE = `+9237${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const PASS = 'TestPass123!';
const FP = { userAgent: 'e2e', screenRes: '1x1', timezone: 'UTC', language: 'en' };

let pass = 0,
  fail = 0;
const P = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
};

// minimal cookie jar + csrf, mirroring the browser client
let cookie = '';
const saveCookies = (res) => {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(';');
    const name = pair.split('=')[0].trim();
    cookie = cookie
      .split('; ')
      .filter((x) => x && !x.startsWith(name + '='))
      .concat(pair)
      .join('; ');
  }
};
const csrf = () =>
  cookie
    .split('; ')
    .find((c) => c.startsWith('csrf_token='))
    ?.split('=')[1] ?? '';

const tinyPng = Buffer.from(
  // 1x1 transparent PNG (valid magic bytes: \x89PNG…)
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// 1. signup (fresh phone; rig DBs start empty)
const login = await fetch(`${API}/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: PHONE, password: PASS, fingerprint: FP }),
});
saveCookies(login);
const loginJson = await login.json();
P(
  'signup',
  login.status === 200 && !!loginJson.data?.accessToken,
  `got ${login.status} ${loginJson?.message ?? ''}`
);
const auth = { Authorization: `Bearer ${loginJson.data?.accessToken}` };

// 2. REJECT: wrong file type (a text file pretending to be png is sniffed out)
const badForm = new FormData();
badForm.append(
  'file',
  new Blob([Buffer.from('not-an-image')], { type: 'image/png' }),
  'fake.png'
);
const bad = await fetch(`${API}/deposits/upload`, {
  method: 'POST',
  headers: { ...auth, 'X-CSRF-Token': csrf(), Cookie: cookie },
  body: badForm,
});
saveCookies(bad);
const badJson = await bad.json().catch(() => null);
P(
  'non-image content is rejected by magic-byte sniff (422 FIN_006)',
  bad.status === 422 && badJson?.code === 'FIN_006',
  `got ${bad.status} ${badJson?.code}`
);

// 3. REJECT: disallowed mimetype
const gifForm = new FormData();
gifForm.append('file', new Blob([tinyPng], { type: 'image/gif' }), 'x.gif');
const gif = await fetch(`${API}/deposits/upload`, {
  method: 'POST',
  headers: { ...auth, 'X-CSRF-Token': csrf(), Cookie: cookie },
  body: gifForm,
});
P('disallowed mimetype rejected (422)', gif.status === 422, `got ${gif.status}`);
await gif.arrayBuffer().catch(() => {});

// 4. ACCEPT: real png through the relay
const goodForm = new FormData();
goodForm.append('file', new Blob([tinyPng], { type: 'image/png' }), 'proof.png');
const good = await fetch(`${API}/deposits/upload`, {
  method: 'POST',
  headers: { ...auth, 'X-CSRF-Token': csrf(), Cookie: cookie },
  body: goodForm,
});
const goodJson = await good.json().catch(() => null);
const objectKey = goodJson?.data?.objectKey;
P(
  'png relay upload returns objectKey',
  good.status === 200 && !!objectKey,
  `got ${good.status} ${JSON.stringify(goodJson)?.slice(0, 120)}`
);
P(
  'objectKey is under this user prefix',
  !!objectKey && objectKey.startsWith('deposits/'),
  objectKey ?? ''
);

// 5. object actually stored in MinIO — read it back with the AWS-style path URL + root creds (path style)
if (objectKey) {
  const { createRequire } = await import('node:module');
  const req = createRequire(new URL('../../api/package.json', import.meta.url));
  const mc = req('minio');
  const client = new mc.Client({
    endPoint: 'localhost',
    port: Number(process.env.MINIO_PORT || 59000),
    useSSL: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
  });
  try {
    const stat = await client.statObject('deposit-proofs', objectKey);
    P(
      'object exists in MinIO deposit-proofs bucket',
      stat.size === tinyPng.length,
      `size=${stat.size}`
    );
  } catch (e) {
    P('object exists in MinIO deposit-proofs bucket', false, String(e).slice(0, 120));
  }
}

// 6. CSRF REQUIRED: same upload without token must 403
const ncForm = new FormData();
ncForm.append('file', new Blob([tinyPng], { type: 'image/png' }), 'proof.png');
const nc = await fetch(`${API}/deposits/upload`, {
  method: 'POST',
  headers: auth,
  body: ncForm,
});
P('upload without CSRF token is refused', nc.status === 403, `got ${nc.status}`);
await nc.arrayBuffer().catch(() => {});

// 7. AUTH REQUIRED: anonymous must 401
const anForm = new FormData();
anForm.append('file', new Blob([tinyPng], { type: 'image/png' }), 'proof.png');
const anon = await fetch(`${API}/deposits/upload`, {
  method: 'POST',
  headers: { 'X-CSRF-Token': csrf(), Cookie: cookie },
  body: anForm,
});
P('anonymous upload is refused (401)', anon.status === 401, `got ${anon.status}`);
await anon.arrayBuffer().catch(() => {});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
