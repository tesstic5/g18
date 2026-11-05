/**
 * JWT signing/verification key resolution.
 *
 * RS256 asymmetric signing (docs/14). In production the operator MUST set
 * JWT_PRIVATE_KEY (PEM PKCS#8) in the environment — see apps/api/.env.example.
 *
 * For local development / sandbox previews where the variable is missing we
 * lazily generate an ephemeral RSA-2048 keypair so the API can boot and issue
 * tokens without erroring. Tokens signed with the ephemeral key are invalidated
 * on restart — acceptable for dev, never for production.
 */
import crypto from 'node:crypto';

let cachedDev: { privateKey: string; publicKey: string } | null = null;

/**
 * Ephemeral RSA-2048 pair used ONLY when no key is configured, so a dev box or
 * sandbox preview can boot. Never reached in production: env-check treats a
 * missing JWT_PRIVATE_KEY as fatal there.
 */
function generateDevKey(): { privateKey: string; publicKey: string } {
  if (cachedDev) return cachedDev;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  cachedDev = { privateKey, publicKey };
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[jwt-keys] JWT_PRIVATE_KEY is not set — using an EPHEMERAL dev key. ' +
        'Tokens will not survive a restart. Set JWT_PRIVATE_KEY for production.'
    );
  }
  return cachedDev;
}

/** The configured private key, or null when the operator has not supplied one. */
function configuredPrivateKey(): string | null {
  const fromEnv = process.env.JWT_PRIVATE_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  // Base64 variant — single-line, safe in .env / Dokploy env vars (D-046)
  const b64 = process.env.JWT_PRIVATE_KEY_B64;
  if (b64 && b64.trim().length > 0) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function getJwtPrivateKey(): string {
  return configuredPrivateKey() ?? generateDevKey().privateKey;
}

export function getJwtPublicKey(): string {
  const fromEnv = process.env.JWT_PUBLIC_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const b64 = process.env.JWT_PUBLIC_KEY_B64;
  if (b64 && b64.trim().length > 0) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      /* fall through */
    }
  }
  // If a private key is configured but no public key, derive the public key
  // from it — otherwise verification would mismatch the signing key. (This
  // must NOT mint a dev key just to compare against: that logged a bogus
  // "JWT_PRIVATE_KEY is not set" warning on correctly configured deployments.)
  const priv = configuredPrivateKey();
  if (priv) {
    try {
      return crypto
        .createPublicKey(priv)
        .export({ type: 'spki', format: 'pem' })
        .toString();
    } catch {
      // fall through to dev pair
    }
  }
  return generateDevKey().publicKey;
}
