// apps/api/src/lib/env-check.ts — one clear startup report of the environment.
//
// Compose's `${VAR:?message}` syntax aborts `docker compose up` on the FIRST
// missing variable, before any container starts. On a hosted panel (Dokploy,
// Coolify) that surfaces as a single cryptic interpolation error with no
// indication of what else is wrong — you fix one, redeploy, and hit the next.
//
// Instead the compose files now supply safe fallbacks and the app reports the
// full picture here, once, at boot: everything missing, everything insecure,
// and exactly what to set.

interface Finding {
  level: 'fatal' | 'warn';
  message: string;
}

/** Values that ship in the examples and must never reach production. */
const INSECURE_DEFAULTS: Record<string, string[]> = {
  S3_ACCESS_KEY: ['minioadmin'],
  S3_SECRET_KEY: ['minioadmin'],
  PG_PASSWORD: ['casino'],
  REDIS_PASSWORD: ['casino'],
  // Shipped verbatim in .env.example — a known cookie secret would forge
  // signed cookies. (ENCRYPTION_KEY/AES_ENCRYPTION_KEY are checked separately
  // above because either name is accepted.)
  COOKIE_SECRET: ['cookie-secret'],
  ADMIN_DEFAULT_PASSWORD: [
    'change-this-now',
    'change-this-immediately',
    'admin',
    'password',
  ],
};

export function checkEnvironment(): Finding[] {
  const isProd = process.env.NODE_ENV === 'production';
  const findings: Finding[] = [];
  const has = (v?: string) => !!v && v.trim().length > 0;

  // ── Hard requirements ────────────────────────────────────────────────
  if (!has(process.env.DATABASE_URL)) {
    findings.push({
      level: 'fatal',
      message: 'DATABASE_URL is not set — the API cannot reach Postgres.',
    });
  }
  if (!has(process.env.REDIS_URL)) {
    findings.push({
      level: 'fatal',
      message: 'REDIS_URL is not set — rounds, rate limits and caching need Redis.',
    });
  }

  // Payout-account encryption. Either name is accepted (see crypto-utils).
  const encKey = process.env.ENCRYPTION_KEY || process.env.AES_ENCRYPTION_KEY;
  if (!has(encKey)) {
    findings.push({
      level: isProd ? 'fatal' : 'warn',
      message:
        'ENCRYPTION_KEY is not set — it encrypts saved payout accounts. ' +
        'Generate one with: openssl rand -hex 32',
    });
  }

  // ── Auth keys ────────────────────────────────────────────────────────
  const hasJwt =
    has(process.env.JWT_PRIVATE_KEY) || has(process.env.JWT_PRIVATE_KEY_B64);
  if (!hasJwt) {
    findings.push({
      level: isProd ? 'fatal' : 'warn',
      message:
        'JWT_PRIVATE_KEY is not set — an ephemeral key is generated at boot, so ' +
        'EVERY user is logged out on each restart/redeploy.',
    });
  }

  if (isProd && !has(process.env.FRONTEND_URL)) {
    findings.push({
      level: 'fatal',
      message:
        'FRONTEND_URL is not set — CORS will reject the browser ("Not allowed by CORS") on every auth call.',
    });
  }

  // ── Object storage (deposit proofs) ──────────────────────────────────
  const s3Public = process.env.S3_PUBLIC_ENDPOINT;
  if (!has(s3Public)) {
    findings.push({
      level: 'warn',
      message:
        'S3_PUBLIC_ENDPOINT is not set — presigned upload URLs will use S3_ENDPOINT. ' +
        'If that is an internal Docker hostname, deposit-proof uploads fail in the ' +
        'browser with ERR_NAME_NOT_RESOLVED. Set it to a publicly reachable URL ' +
        '(e.g. http://YOUR_VPS_IP:9000).',
    });
  }

  // ── Insecure example values left in place ────────────────────────────
  if (isProd) {
    // The shipped example AES key under EITHER accepted name must never boot.
    if (encKey && encKey.trim() === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') {
      findings.push({
        level: 'fatal',
        message:
          'ENCRYPTION_KEY is still the .env.example value — refusing to start in production. ' +
          'Generate one with: openssl rand -hex 32',
      });
    }
    // COOKIE_SECRET unset is only a WARNING: it was never a required variable
    // before, and making it fatal broke existing deployments on upgrade.
    // The known weak example value below remains fatal.
    if (!has(process.env.COOKIE_SECRET)) {
      findings.push({
        level: 'warn',
        message:
          'COOKIE_SECRET is not set — cookies are signed with an ephemeral secret and all ' +
          'sessions invalidate on restart. Set one: openssl rand -hex 32',
      });
    }
    for (const [name, bad] of Object.entries(INSECURE_DEFAULTS)) {
      const value = process.env[name];
      if (has(value) && bad.includes(value!.trim())) {
        findings.push({
          level: 'fatal',
          message: `${name} is still the example value ("${value}") — refusing to start in production.`,
        });
      }
      if (!has(value)) {
        // COOKIE_SECRET is handled above (warn, not fatal, for upgrade safety).
        if (name === 'COOKIE_SECRET') continue;
        findings.push({
          level: 'fatal',
          message: `${name} is not set — generate a strong value (openssl rand -hex 32) before deployment.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Print the report. Returns false when the process should not continue.
 * Never throws — a config checker must not be the thing that crashes boot.
 */
export function reportEnvironment(): boolean {
  let findings: Finding[] = [];
  try {
    findings = checkEnvironment();
  } catch {
    return true;
  }
  if (findings.length === 0) return true;

  const fatal = findings.filter((f) => f.level === 'fatal');
  const warn = findings.filter((f) => f.level === 'warn');

  console.error('\n──────────── CONFIGURATION ────────────');
  for (const f of fatal) console.error(`  ✖ ${f.message}`);
  for (const f of warn) console.error(`  ⚠ ${f.message}`);
  console.error('───────────────────────────────────────\n');

  if (fatal.length > 0) {
    console.error(
      `Refusing to start: ${fatal.length} required setting(s) missing. ` +
        'Add them in your host panel (Dokploy/Coolify → Environment) and redeploy.\n'
    );
    return false;
  }
  return true;
}
