// apps/api/src/lib/crypto-utils.ts — AES-256-GCM encrypt/decrypt for sensitive
// player data (payout account details, D-074). Key derived from ENCRYPTION_KEY
// or the deployment's JWT private key (stable per deploy) — never stored plaintext.
import crypto from 'crypto';

function secretFromEnv(): string | null {
  // AES_ENCRYPTION_KEY is the ORIGINAL variable name and is still set by
  // existing deployments. Accept both, preferring the current name, so a
  // rename can never make previously-encrypted payout accounts unreadable.
  return (
    process.env.ENCRYPTION_KEY ||
    process.env.AES_ENCRYPTION_KEY ||
    process.env.JWT_PRIVATE_KEY ||
    null
  );
}

function key(): Buffer {
  const secret = secretFromEnv();
  if (!secret) {
    // In production a missing key would silently encrypt every payout account
    // with a hardcoded string — refuse instead.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENCRYPTION_KEY (or AES_ENCRYPTION_KEY) must be set in production — it encrypts payout account details'
      );
    }
    return crypto.createHash('sha256').update('dev-only-fallback-key').digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * KEY ROTATION SUPPORT.
 *
 * Rotating ENCRYPTION_KEY used to be a one-way door: every payout account and
 * the stored SMTP password were encrypted with the old key and simply became
 * unreadable (decryptJson threw). Now the operator sets the new key in
 * ENCRYPTION_KEY and the retired one in ENCRYPTION_KEY_PREVIOUS, which:
 *
 *   1. lets every existing row keep being DECRYPTED (reads keep working), and
 *   2. enables POST /panel/maintenance/rotate-encryption-key, which re-encrypts
 *      every row with the new key and then tells the operator to drop
 *      ENCRYPTION_KEY_PREVIOUS.
 *
 * Multiple retired keys are accepted (oldest last) so two rotations inside one
 * maintenance window cannot strand data either.
 */
function previousKeys(): Buffer[] {
  return String(process.env.ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((secret) => crypto.createHash('sha256').update(secret).digest());
}

/** True when a retired key is still configured (i.e. a rotation is in flight). */
export function hasPreviousKey(): boolean {
  return previousKeys().length > 0;
}

function decryptWith(encKey: Buffer, payload: string): unknown {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8')) as unknown;
}

/** Decrypt with a specific key. Used by the rotation job, never by readers. */
export function decryptJsonWithKey<T>(secret: string, payload: string): T {
  return decryptWith(crypto.createHash('sha256').update(secret).digest(), payload) as T;
}

/**
 * Re-wrap a payload under the CURRENT key, whichever key opened it. Returns the
 * new ciphertext. Throws when no configured key can open it — the rotation job
 * reports those rows instead of overwriting them with garbage.
 *
 * This is the primitive the rotation endpoint is built on, so both the payout
 * accounts and the stored SMTP password rotate through identical code.
 */
export function reencryptToCurrentKey(payload: string): { kind: 'current' | 'previous'; value: string } {
  const kind = keyKindFor(payload);
  if (kind === 'current') return { kind, value: payload };
  // decryptJson already falls back to the retired keys.
  return { kind, value: encryptJson(decryptJson(payload)) };
}

/** Encrypt with a specific key (rotation writes with the NEW key). */
export function encryptJsonWithKey(secret: string, value: unknown): string {
  const encKey = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const plain = JSON.stringify(value);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/**
 * Which key opens this payload: 'current' or 'previous'. Used by the rotation
 * endpoint to report progress and by tests. Throws when nothing opens it —
 * which is the honest answer for a row encrypted before a key was set that no
 * longer exists anywhere.
 */
export function keyKindFor(payload: string): 'current' | 'previous' {
  try {
    decryptWith(key(), payload);
    return 'current';
  } catch {
    /* fall through to retired keys */
  }
  for (const retired of previousKeys()) {
    try {
      decryptWith(retired, payload);
      return 'previous';
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No configured key can decrypt this payload');
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const plain = JSON.stringify(value);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(
    '.'
  );
}

/**
 * Decrypt with the CURRENT key, falling back to retired keys. The fallback is
 * what makes a rotation non-destructive: between setting ENCRYPTION_KEY and
 * running the re-encrypt job, rows are split across both keys and every read
 * must keep working.
 */
export function decryptJson<T>(payload: string): T {
  try {
    return decryptWith(key(), payload) as T;
  } catch (primaryError) {
    for (const retired of previousKeys()) {
      try {
        return decryptWith(retired, payload) as T;
      } catch {
        /* try the next retired key */
      }
    }
    throw primaryError;
  }
}

/**
 * Non-reversible fingerprint of the CURRENT key: sha256(secret) truncated to 16
 * hex chars. The backup scripts and the panel archive both record it, so a
 * restore can tell you BEFORE touching anything whether this deployment can read
 * the encrypted fields inside a backup.
 */
export function currentKeyFingerprint(): string {
  const secret = secretFromEnv();
  if (!secret) return 'none';
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}
