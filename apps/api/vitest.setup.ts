// vitest.setup.ts — ephemeral RSA key + env for tests (RS256 JWT, docs/14)
import { generateKeyPairSync } from 'crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.JWT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ||
  'test-access-secret-12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ||
  'test-refresh-secret-12345678901234567890123456789012';
process.env.JWT_ADMIN_SECRET =
  process.env.JWT_ADMIN_SECRET || 'test-admin-secret-12345678901234567890123456789012';
process.env.AES_ENCRYPTION_KEY =
  process.env.AES_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret';

// ── Guard against running the suite against a real database ────────────────
// The integration suite (src/integration/flows.test.ts) writes REAL users,
// wallets, deposits and ledger rows, and it has no transaction rollback and no
// cleanup. Pointing it at production does not just pollute it: funding a wallet
// without a ledger row used to leave wallet ≠ ledger forever, which makes the
// worker's reconciliationCheck fail permanently.
//
// So: fail fast on a database that is not obviously a local/throwaway one.
// Single-label hosts (`postgres`, `db`) count as local — that is how the
// compose stacks address each other.
const rawUrl = process.env.DATABASE_URL ?? '';
let dbHost = '';
try {
  dbHost = new URL(rawUrl.replace(/^postgres(ql)?:/, 'http:')).hostname;
} catch {
  /* unparseable — leave dbHost empty, the warning below still fires */
}
const isLocalHost =
  dbHost === '' ||
  ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(dbHost) ||
  !dbHost.includes('.'); // container/service names: postgres, db, redis

if (
  process.env.NODE_ENV === 'production' &&
  process.env.ALLOW_DESTRUCTIVE_TESTS !== '1'
) {
  throw new Error(
    'Refusing to run the test suite with NODE_ENV=production. The integration ' +
      'suite writes real rows with no cleanup. Set ALLOW_DESTRUCTIVE_TESTS=1 ' +
      'only if you really mean it.'
  );
}

if (!isLocalHost && process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
  throw new Error(
    `Refusing to run the test suite against non-local database host "${dbHost}". ` +
      'The integration suite creates real users, deposits and ledger rows and ' +
      'does not clean up after itself. Point DATABASE_URL at a throwaway ' +
      'database, or set ALLOW_DESTRUCTIVE_TESTS=1 to override.'
  );
}

if (rawUrl && process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
  console.error(
    `[test-env] DATABASE_URL host "${dbHost || 'unknown'}" — the integration ` +
      'suite will write real rows here and will not roll them back.'
  );
}
