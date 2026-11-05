// apps/api/src/services/smtpFlow.test.ts — end-to-end: the values an admin
// types into the panel must actually produce a delivered email. Covers the
// encryption-at-rest boundary (the plaintext password must never appear in what
// we store OR in what the panel reads back) and a real SMTP conversation
// against a socket server, including the encrypted-backup attachment.
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  smtpFromSettings,
  prepareSmtpPatch,
  recipientsFromSettings,
  maskSmtpSettings,
} from './smtpSettings';
import { sendMail } from '../lib/smtp';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

interface Captured {
  data: string;
  attachments: Buffer[];
}

function startSmtp(): Promise<{ port: number; captured: Captured; close: () => Promise<void> }> {
  const captured: Captured = { data: '', attachments: [] };
  let data = '';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    let inData = false;
    socket.write('220 mail.test ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
            captured.data = data;
            const b64 = data
              .split('\n')
              .filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l))
              .join('');
            if (b64) captured.attachments.push(Buffer.from(b64, 'base64'));
          } else data += line + '\n';
          continue;
        }
        const c = line.toUpperCase();
        if (c.startsWith('EHLO'))
          socket.write('250-mail.test\r\n250-SIZE 52428800\r\n250-AUTH PLAIN LOGIN\r\n250 SMTPUTF8\r\n');
        else if (c.startsWith('AUTH PLAIN')) socket.write('235 2.7.0 Authentication successful\r\n');
        else if (c.startsWith('MAIL') || c.startsWith('RCPT')) socket.write('250 2.1.0 ok\r\n');
        else if (c === 'DATA') {
          inData = true;
          data = '';
          socket.write('354 End data\r\n');
        } else if (c === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        captured,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    )
  );
}

describe('panel-configured SMTP → real delivery', () => {
  it('goes from admin form values to a delivered email with the backup attached', async () => {
    const server = await startSmtp();

    // 1. What the PATCH route persists (password encrypted, not plaintext).
    const stored = prepareSmtpPatch({
      backup_email_enabled: true,
      smtp_host: '127.0.0.1',
      smtp_port: server.port,
      smtp_secure: false,
      smtp_user: 'backups@casino.test',
      smtp_password: 'gmail-app-password-16ch',
      smtp_from: 'backups@casino.test',
      backup_email_to: 'owner@casino.test, second@casino.test',
      smtp_require_tls: false, // this test server offers no STARTTLS
      smtp_allow_self_signed: false,
    });
    expect(JSON.stringify(stored)).not.toContain('gmail-app-password-16ch');

    // 2. What the panel GETs back — masked, flagged, never the secret.
    const masked = maskSmtpSettings(stored);
    expect(masked.smtp_password).toBe('••••••••');
    expect(masked.smtp_password_set).toBe(true);
    expect(JSON.stringify(masked)).not.toContain('gmail-app-password-16ch');

    // 3. What the nightly job resolves.
    const smtp = smtpFromSettings(stored, {} as NodeJS.ProcessEnv)!;
    const recipients = recipientsFromSettings(stored, {} as NodeJS.ProcessEnv);
    expect(smtp.user).toBe('backups@casino.test');
    expect(smtp.pass).toBe('gmail-app-password-16ch');
    expect(recipients).toEqual(['owner@casino.test', 'second@casino.test']);

    // 4. Real SMTP conversation with the encrypted backup attached.
    // Credentials are stripped for this plaintext test server: the client
    // refuses to send them over an unencrypted link (asserted in smtp.test.ts).
    // Their decryption was still verified in step 3 above.
    const sendOpts = { ...smtp, user: undefined, pass: undefined };
    const file = path.join(os.tmpdir(), `nightly-${Date.now()}.cbk`);
    fs.writeFileSync(file, JSON.stringify({ v: 1, ct: 'ZmFrZS1jaXBoZXJ0ZXh0' }));
    const res = await sendMail(sendOpts, {
      to: recipients,
      subject: '[casino] Encrypted backup 128.4 KB — 2026-09-19',
      text: 'Encrypted backup attached.\nSHA-256: abc123',
      attachments: [{ filename: 'nightly.cbk', content: fs.readFileSync(file) }],
    });

    expect(res.accepted).toEqual(['owner@casino.test', 'second@casino.test']);
    // The subject contains an em-dash, so the client RFC 2047-encodes it.
    // Decode it back and compare the real text — stronger than a substring check.
    const subjectLine = server.captured.data
      .split('\n')
      .find((l) => l.startsWith('Subject:'))!;
    const encoded = subjectLine.slice('Subject: '.length).trim();
    const decoded = encoded.startsWith('=?UTF-8?B?')
      ? Buffer.from(encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8')
      : encoded;
    expect(decoded).toBe('[casino] Encrypted backup 128.4 KB — 2026-09-19');
    expect(server.captured.data).toContain('filename="nightly.cbk"');
    expect(server.captured.attachments[0]!.equals(fs.readFileSync(file))).toBe(true);

    await server.close();
  });
});
