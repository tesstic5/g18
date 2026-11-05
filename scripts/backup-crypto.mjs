#!/usr/bin/env node
// scripts/backup-crypto.mjs — encrypt/decrypt backups with NO dependencies.
//
// DESIGN (why not the admin password):
//   The server holds only a PUBLIC key. It can create backups forever but can
//   never decrypt one, so a compromised VPS does not expose your history. The
//   private key never touches the server — keep it offline (password manager,
//   USB stick, printed recovery sheet).
//
//   Two modes:
//     recipient (recommended)  X25519 ECDH + HKDF-SHA256 + AES-256-GCM
//     passphrase               scrypt + AES-256-GCM (for humans without a key)
//
// USAGE
//   node scripts/backup-crypto.mjs keygen  --private backup-key.txt --public backup-key.pub
//   node scripts/backup-crypto.mjs encrypt --to backup-key.pub --in dump.json --out dump.json.cbk
//   node scripts/backup-crypto.mjs decrypt --key backup-key.txt --in dump.json.cbk --out dump.json
//   node scripts/backup-crypto.mjs encrypt --passphrase --in dump.json --out dump.cbk   # prompts
//
// The .cbk file is JSON so it can be emailed, stored in object storage, or
// pasted anywhere. Nothing in it is readable without the key.

import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const V = 1;
const X25519 = 'x25519-hkdf-sha256-aes256gcm';
const SCRYPT = 'scrypt-aes256gcm';
// scrypt cost: ~100ms and 128 MiB on a modern box. Strong enough that a
// passphrase file is not the weak link; low enough to run on a small VPS.
const SCRYPT_N = 1 << 17;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mask keystrokes for a passphrase.
      const onData = (ch) => {
        if (String(ch) === '\n' || String(ch) === '\r') return;
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        process.stdout.write(question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
      rl.question(question, (answer) => {
        process.stdin.off('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
      return;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── recipient mode ─────────────────────────────────────────────────────────

/** Derive a 32-byte AES key from an X25519 shared secret. */
function x25519AesKey(privateKeyObject, peerPublicKeyObject, ephemeralPubRaw, recipientPubRaw) {
  const shared = crypto.diffieHellman({ privateKey: privateKeyObject, publicKey: peerPublicKeyObject });
  // Bind BOTH public keys as HKDF "info" so a ciphertext cannot be replayed
  // against a different keypair, and so the two sides always agree.
  const info = Buffer.concat([Buffer.from('casino-backup-v1'), ephemeralPubRaw, recipientPubRaw]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), info, KEY_BYTES));
}

function encryptToRecipient(data, publicKeyB64) {
  const recipientRaw = Buffer.from(publicKeyB64.trim(), 'base64');
  if (recipientRaw.length !== 32) die('public key must be 32 bytes of base64');
  const recipientPub = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), recipientRaw]),
    format: 'der',
    type: 'spki',
  });
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = x25519AesKey(eph.privateKey, recipientPub, ephRaw, recipientRaw);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: V,
    alg: X25519,
    recipient: recipientRaw.toString('base64'),
    ephemeral: Buffer.from(ephRaw).toString('base64'),
    nonce: nonce.toString('base64'),
    ct: Buffer.concat([ct, tag]).toString('base64'),
  };
}

function decryptWithPrivateKey(envelope, privateKeyText) {
  const raw = Buffer.from(privateKeyText.trim().replace(/^.*KEY-----|-----.*$/g, '').replace(/\s+/g, ''), 'base64');
  if (raw.length !== 32) die('private key must be 32 bytes of base64 (from `keygen`)');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const ephRaw = Buffer.from(envelope.ephemeral, 'base64');
  const ephPub = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephRaw]),
    format: 'der',
    type: 'spki',
  });
  const key = x25519AesKey(privateKey, ephPub, ephRaw, pubRaw);
  const blob = Buffer.from(envelope.ct, 'base64');
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── passphrase mode ────────────────────────────────────────────────────────

function encryptWithPassphrase(data, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 256 * 1024 * 1024 });
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    v: V,
    alg: SCRYPT,
    kdf: { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p },
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: Buffer.concat([ct, cipher.getAuthTag()]).toString('base64'),
  };
}

function decryptWithPassphrase(envelope, passphrase) {
  const k = envelope.kdf ?? { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p };
  const key = crypto.scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), KEY_BYTES, {
    N: k.N,
    r: k.r,
    p: k.p,
    maxmem: 512 * 1024 * 1024,
  });
  const blob = Buffer.from(envelope.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
}

// ── exported helpers (also used by the worker) ──────────────────────────────

export const ALGORITHMS = { X25519, SCRYPT };
export { encryptToRecipient, decryptWithPrivateKey, encryptWithPassphrase, decryptWithPassphrase };

/** Is this buffer/JSON a backup envelope (not a raw dump)? */
export function isEnvelope(text) {
  try {
    const j = JSON.parse(text);
    return j && j.v === V && typeof j.ct === 'string' && (j.alg === X25519 || j.alg === SCRYPT);
  } catch {
    return false;
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'keygen') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
    const privPath = arg('private', 'backup-key.txt');
    const pubPath = arg('public', 'backup-key.pub');
    fs.writeFileSync(pubPath, pub + '\n', { mode: 0o644 });
    fs.writeFileSync(privPath, priv + '\n', { mode: 0o600 });
    console.log(`public key  -> ${pubPath}   (safe to keep on the server)`);
    console.log(`private key -> ${privPath}   (KEEP OFFLINE — without it the backups are unreadable)`);
    return;
  }

  if (cmd === 'encrypt') {
    const inPath = arg('in');
    if (!inPath) die('--in is required');
    const data = fs.readFileSync(inPath);
    let envelope;
    // --passphrase-env VAR reads the passphrase from an environment variable, so
    // an unattended script never types it twice and it never shows up in the
    // process list (unlike --passphrase on argv).
    const passEnv = arg('passphrase-env');
    if (passEnv) {
      const p = process.env[passEnv];
      if (!p) die(`environment variable ${passEnv} is empty`);
      if (p.length < 12) die('use at least 12 characters');
      envelope = encryptWithPassphrase(data, p);
    } else if (has('passphrase')) {
      const p1 = await prompt('Passphrase: ', { hidden: true });
      const p2 = await prompt('Repeat:     ', { hidden: true });
      if (p1 !== p2) die('passphrases do not match');
      if (p1.length < 12) die('use at least 12 characters');
      envelope = encryptWithPassphrase(data, p1);
    } else {
      const toPath = arg('to', 'backup-key.pub');
      if (!fs.existsSync(toPath)) die(`recipient public key not found: ${toPath} (run: keygen)`);
      envelope = encryptToRecipient(data, fs.readFileSync(toPath, 'utf8'));
    }
    const outPath = arg('out', `${inPath}.cbk`);
    fs.writeFileSync(outPath, JSON.stringify(envelope));
    const plain = fs.statSync(inPath).size;
    const enc = fs.statSync(outPath).size;
    if (!has('quiet')) {
      console.log(`encrypted ${inPath} -> ${outPath}`);
      console.log(`  ${plain} bytes -> ${enc} bytes (${((enc / plain - 1) * 100).toFixed(1)}% overhead)`);
    }
    return;
  }

  if (cmd === 'decrypt') {
    const inPath = arg('in');
    if (!inPath) die('--in is required');
    const envelope = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    let plain;
    try {
      if (envelope.alg === SCRYPT || has('passphrase')) {
        const p = await prompt('Passphrase: ', { hidden: true });
        plain = decryptWithPassphrase(envelope, p);
      } else if (envelope.alg === X25519) {
        const keyPath = arg('key', 'backup-key.txt');
        if (!fs.existsSync(keyPath)) die(`private key not found: ${keyPath}`);
        plain = decryptWithPrivateKey(envelope, fs.readFileSync(keyPath, 'utf8'));
      } else {
        die(`unsupported envelope: ${envelope.alg}`);
      }
    } catch (e) {
      die(`decryption failed (${e.message}) — wrong key, or the file was modified`);
    }
    const outPath = arg('out', inPath.replace(/\.cbk$/, ''));
    fs.writeFileSync(outPath, plain);
    console.log(`decrypted ${inPath} -> ${outPath} (${plain.length} bytes)`);
    return;
  }

  console.log(`usage:
  keygen  --private backup-key.txt --public backup-key.pub
  encrypt --to backup-key.pub --in <file> [--out <file>]
  encrypt --passphrase --in <file> [--out <file>]        (prompts)
  encrypt --passphrase-env VAR --in <file>               (unattended)
  decrypt --key backup-key.txt --in <file.cbk> [--out <file>]
  decrypt --in <file.cbk>            (prompts for the passphrase)`);
  process.exit(cmd ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((e) => die(e.message));
}
