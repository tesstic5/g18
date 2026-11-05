import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  emailBackup,
  recipientsFromEnv,
  sha256File,
  smtpFromEnv,
} from './backupDelivery';
import type { SmtpOptions, MailMessage } from '../lib/smtp';

const tmpFiles: string[] = [];
function tmpBackup(content: Buffer | string): string {
  const p = path.join(os.tmpdir(), `bk-${crypto.randomUUID()}.cbk`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  while (tmpFiles.length) fs.rmSync(tmpFiles.pop()!, { force: true });
});

const configuredEnv: NodeJS.ProcessEnv = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'backups@example.test',
  SMTP_PASS: 'secret',
  SMTP_FROM: 'backups@example.test',
  BACKUP_EMAIL_TO: 'owner@example.test',
};

describe('smtpFromEnv', () => {
  it('returns null when SMTP is not configured (feature stays inert)', () => {
    expect(smtpFromEnv({})).toBeNull();
    expect(smtpFromEnv({ SMTP_HOST: 'x' })).toBeNull(); // no from address
  });

  it('defaults to port 587 with requireTls', () => {
    const o = smtpFromEnv(configuredEnv)!;
    expect(o.port).toBe(587);
    expect(o.secure).toBe(false);
    expect(o.requireTls).toBe(true);
  });

  it('treats port 465 as implicit TLS', () => {
    const o = smtpFromEnv({ ...configuredEnv, SMTP_PORT: '465' })!;
    expect(o.secure).toBe(true);
  });

  it('allows opting into strict TLS validation by exception only', () => {
    expect(smtpFromEnv(configuredEnv)!.rejectUnauthorized).toBe(true);
    expect(
      smtpFromEnv({ ...configuredEnv, SMTP_ALLOW_SELF_SIGNED: 'true' })!.rejectUnauthorized
    ).toBe(false);
  });
});

describe('recipientsFromEnv', () => {
  it('splits, trims and drops blanks', () => {
    expect(recipientsFromEnv({ BACKUP_EMAIL_TO: ' a@x.test , b@y.test ,, ' })).toEqual([
      'a@x.test',
      'b@y.test',
    ]);
  });

  it('returns empty when unset', () => {
    expect(recipientsFromEnv({})).toEqual([]);
  });
});

describe('emailBackup', () => {
  it('skips (not fails) when SMTP is not configured', async () => {
    const send = vi.fn();
    const res = await emailBackup({ filePath: tmpBackup('x'), env: {}, send });
    expect(res.status).toBe('skipped');
    expect(res.detail).toMatch(/SMTP is not configured/);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when no recipient is configured', async () => {
    const send = vi.fn();
    const { BACKUP_EMAIL_TO: _omit, ...noRecipient } = configuredEnv;
    const res = await emailBackup({ filePath: tmpBackup('x'), env: noRecipient, send });
    expect(res.status).toBe('skipped');
    // Recipients can come from the panel settings or BACKUP_EMAIL_TO, so the
    // message no longer names just the env var.
    expect(res.detail).toMatch(/recipient/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('attaches a small backup and reports the real SHA-256', async () => {
    const content = Buffer.from('{"v":1,"alg":"x25519-hkdf-sha256-aes256gcm","ct":"AAAA"}');
    const file = tmpBackup(content);
    let sent: MailMessage | undefined;
    const send = vi.fn(async (_o: SmtpOptions, m: MailMessage) => {
      sent = m;
      return { accepted: ['owner@example.test'] };
    });

    const res = await emailBackup({ filePath: file, env: configuredEnv, send });

    expect(res.status).toBe('sent');
    expect(res.accepted).toEqual(['owner@example.test']);
    expect(sent!.attachments).toHaveLength(1);
    expect(sent!.attachments![0]!.content.equals(content)).toBe(true);
    expect(sent!.text).toContain(sha256File(file));
    expect(sent!.text).toContain('backup-crypto.mjs decrypt');
  });

  it('sends a NOTICE without the attachment when the file is too large', async () => {
    const file = tmpBackup(Buffer.alloc(2048));
    let sent: MailMessage | undefined;
    const send = vi.fn(async (_o: SmtpOptions, m: MailMessage) => {
      sent = m;
      return { accepted: ['owner@example.test'] };
    });

    const res = await emailBackup({
      filePath: file,
      env: { ...configuredEnv, BACKUP_EMAIL_MAX_BYTES: '1024' },
      send,
    });

    expect(res.status).toBe('sent');
    expect(res.detail).toMatch(/notice/);
    // No attachment is carried (empty or omitted — both mean "notice only").
    expect(sent!.attachments ?? []).toHaveLength(0);
    expect(sent!.subject).toMatch(/too large to attach/i);
    expect(sent!.text).toContain('NOT attached');
  });

  it('reports failure instead of throwing when the mail server is down', async () => {
    const send = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const res = await emailBackup({ filePath: tmpBackup('x'), env: configuredEnv, send });
    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/ECONNREFUSED/);
  });

  it('fails cleanly when the backup file vanished', async () => {
    const send = vi.fn();
    const res = await emailBackup({
      filePath: path.join(os.tmpdir(), 'definitely-missing.cbk'),
      env: configuredEnv,
      send,
    });
    expect(res.status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('never leaks the SMTP password or key material into the message body', async () => {
    const file = tmpBackup('{"ct":"ciphertext-here"}');
    let sent: MailMessage | undefined;
    const send = vi.fn(async (_o: SmtpOptions, m: MailMessage) => {
      sent = m;
      return { accepted: ['owner@example.test'] };
    });
    await emailBackup({ filePath: file, env: configuredEnv, send });
    expect(sent!.text).not.toContain('secret');
    expect(sent!.text).not.toContain('{"ct":"ciphertext-here"}');
  });
});

// The worker calls emailBackup({ filePath, bytes }) with NO env and no smtp:
// it must resolve live panel settings, and if the settings store is unreachable
// it must degrade to env-only and SKIP — never throw, never lose the backup.
describe('worker path (no explicit env)', () => {
  // Deterministic: hide any SMTP_*/BACKUP_EMAIL_* the test runner happens to
  // have, so "not configured" really means not configured.
  const MAIL_VARS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'BACKUP_EMAIL_TO',
    'BACKUP_EMAIL_ENABLED',
  ];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of MAIL_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of MAIL_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('skips cleanly when nothing is configured anywhere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(async () => ({ accepted: ['nobody@example.test'] }));
    const res = await emailBackup({ filePath: tmpBackup('worker'), bytes: 10, send });
    expect(res.status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws even when settings resolution fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await emailBackup({ filePath: '/definitely/not/here.cbk' });
    // Either "skipped" (nothing configured) or "failed" (file missing) is a
    // fine, non-throwing outcome — what matters is the worker keeps running.
    expect(['skipped', 'failed']).toContain(res.status);
    expect(res.status).not.toBe('sent');
    warn.mockRestore();
    err.mockRestore();
  });
});
