// apps/api/src/lib/backupEnvelope.ts — recipient-key backup encryption.
//
// Sibling of scripts/backup-crypto.mjs (same wire format, v1). The server holds
// only a PUBLIC key: it can produce backups forever and can never read them
// back, so a compromised host does not expose the platform's history. Decrypt
// offline with:
//
//   node scripts/backup-crypto.mjs decrypt --key backup-key.txt --in x.cbk --out x.json
//
// Format (JSON, so it can be emailed or dropped in object storage):
//   { v:1, alg:"x25519-hkdf-sha256-aes256gcm", recipient, ephemeral, nonce, ct }
//     ct = AES-256-GCM ciphertext || 16-byte tag
import crypto from 'node:crypto';

const V = 1;
export const ENVELOPE_ALG = 'x25519-hkdf-sha256-aes256gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
// DER prefixes for raw 32-byte X25519 keys (avoids shipping JWK/ASN.1 plumbing).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface BackupEnvelope {
  v: number;
  alg: string;
  recipient: string;
  ephemeral: string;
  nonce: string;
  ct: string;
}

/** 32-byte raw X25519 public key, base64 (what `keygen` writes to backup-key.pub). */
export type PublicKeyB64 = string;

export class BackupCryptoError extends Error {}

function deriveKey(
  privateKey: crypto.KeyObject,
  peerPublicKey: crypto.KeyObject,
  ephemeralRaw: Buffer,
  recipientRaw: Buffer
): Buffer {
  const shared = crypto.diffieHellman({ privateKey, publicKey: peerPublicKey });
  const info = Buffer.concat([Buffer.from('casino-backup-v1'), ephemeralRaw, recipientRaw]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), info, KEY_BYTES));
}

export function publicKeyFromRaw(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64.trim(), 'base64');
  if (raw.length !== 32) throw new BackupCryptoError('public key must be 32 bytes of base64');
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function privateKeyFromRaw(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64.trim(), 'base64');
  if (raw.length !== 32) throw new BackupCryptoError('private key must be 32 bytes of base64');
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function rawPublicOf(privateKey: crypto.KeyObject): Buffer {
  return crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
}

/** Encrypt with the operator's PUBLIC key only. No private key is involved. */
export function encryptForRecipient(data: Buffer, publicKeyB64: PublicKeyB64): BackupEnvelope {
  const recipientRaw = Buffer.from(publicKeyB64.trim(), 'base64');
  const recipientPub = publicKeyFromRaw(publicKeyB64);
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = deriveKey(eph.privateKey, recipientPub, Buffer.from(ephRaw), recipientRaw);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return {
    v: V,
    alg: ENVELOPE_ALG,
    recipient: recipientRaw.toString('base64'),
    ephemeral: Buffer.from(ephRaw).toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Decrypt with the OFFLINE private key. Throws BackupCryptoError on any failure. */
export function decryptEnvelope(envelope: BackupEnvelope, privateKeyB64: string): Buffer {
  if (!envelope || envelope.v !== V || envelope.alg !== ENVELOPE_ALG) {
    throw new BackupCryptoError(`unsupported envelope (expected v${V} ${ENVELOPE_ALG})`);
  }
  try {
    const privateKey = privateKeyFromRaw(privateKeyB64);
    const recipientRaw = rawPublicOf(privateKey);
    const ephRaw = Buffer.from(envelope.ephemeral, 'base64');
    const ephPub = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, ephRaw]),
      format: 'der',
      type: 'spki',
    });
    const key = deriveKey(privateKey, ephPub, ephRaw, Buffer.from(recipientRaw));
    const blob = Buffer.from(envelope.ct, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  } catch (e) {
    throw new BackupCryptoError(
      `decryption failed (${(e as Error).message}) — wrong key, or the file was modified`
    );
  }
}

/** True when the text looks like an encrypted envelope rather than a raw dump. */
export function isBackupEnvelope(text: string | Buffer): boolean {
  try {
    const j = JSON.parse(typeof text === 'string' ? text : text.toString('utf8')) as BackupEnvelope;
    return !!j && j.v === V && j.alg === ENVELOPE_ALG && typeof j.ct === 'string';
  } catch {
    return false;
  }
}
