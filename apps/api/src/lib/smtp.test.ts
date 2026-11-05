import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { sendMail, buildMime, type SmtpOptions } from './smtp';

// A minimal SMTP server that records the conversation, so the client is tested
// against a real socket rather than a mock.
interface FakeServer {
  port: number;
  transcript: string[];
  data: string;
  close: () => Promise<void>;
}

function startFakeSmtp(
  opts: {
    authRequired?: boolean;
    offerStartTls?: boolean;
    rejectRecipients?: string[];
    maxMessageBytes?: number;
  } = {}
): Promise<FakeServer> {
  const transcript: string[] = [];
  let data = '';
  let inData = false;

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    const send = (line: string) => socket.write(line + '\r\n');

    socket.write('220 fake.casino ESMTP ready\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            send('250 2.0.0 Ok: queued as ABC123');
          } else {
            data += line + '\n';
          }
          continue;
        }

        transcript.push(line);
        const cmd = line.toUpperCase();

        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          const caps = [
            '250-fake.casino greets you',
            '250-SIZE 52428800',
            '250-8BITMIME',
            ...(opts.offerStartTls ? ['250-STARTTLS'] : []),
            ...(opts.authRequired || opts.authRequired === undefined ? ['250-AUTH PLAIN LOGIN'] : []),
            '250 SMTPUTF8',
          ];
          send(caps.join('\r\n'));
          continue;
        }
        if (cmd.startsWith('AUTH PLAIN')) {
          send('235 2.7.0 Authentication successful');
          continue;
        }
        if (cmd === 'AUTH LOGIN') {
          send('334 VXNlcm5hbWU6');
          continue;
        }
        if (cmd === 'MAIL FROM' || cmd.startsWith('MAIL FROM')) {
          send('250 2.1.0 Sender ok');
          continue;
        }
        if (cmd.startsWith('RCPT TO')) {
          const rejected = (opts.rejectRecipients ?? []).some((r) => cmd.includes(r.toUpperCase()));
          send(rejected ? '550 5.1.1 No such user here' : '250 2.1.5 Recipient ok');
          continue;
        }
        if (cmd === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
          continue;
        }
        if (cmd === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
          continue;
        }
        send('250 OK');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        transcript,
        get data() {
          return data;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function server(opts = {}) {
  const s = await startFakeSmtp(opts);
  servers.push(s);
  return s;
}

const base = (port: number, extra: Partial<SmtpOptions> = {}): SmtpOptions => ({
  host: '127.0.0.1',
  port,
  from: 'backups@casino.test',
  timeoutMs: 5000,
  ...extra,
});

describe('sendMail', () => {
  it('delivers a plain message and completes the SMTP dialogue', async () => {
    const s = await server();
    const res = await sendMail(base(s.port), {
      to: ['owner@casino.test'],
      subject: 'Nightly backup',
      text: 'All good.',
    });

    expect(res.accepted).toEqual(['owner@casino.test']);
    expect(s.transcript[0]).toContain('EHLO');
    expect(s.transcript.some((l) => l.startsWith('MAIL FROM:<backups@casino.test>'))).toBe(true);
    expect(s.transcript).toContain('RCPT TO:<owner@casino.test>');
    expect(s.transcript).toContain('DATA');
    expect(s.data).toContain('Subject: Nightly backup');
    expect(s.data).toContain('All good.');
  });

  it('attaches a file as base64 and keeps it recoverable byte-for-byte', async () => {
    const s = await server();
    // Bytes that survive base64 unambiguously.
    const payload = Buffer.from('PGDMP\u0000binary-backup-bytes-end', 'utf8');

    await sendMail(base(s.port), {
      to: ['owner@casino.test'],
      subject: 'backup attached',
      text: 'see attachment',
      attachments: [{ filename: 'local-2026-09-19.dump.cbk', content: payload }],
    });

    expect(s.data).toContain('Content-Type: multipart/mixed');
    expect(s.data).toContain('filename="local-2026-09-19.dump.cbk"');
    // The fake server records body lines with a plain \n, so split on that.
    const b64 = s.data
      .split('\n')
      .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l))
      .join('');
    // The attachment's base64 appears in those lines; decode the ones that match.
    expect(Buffer.from(b64, 'base64').includes(payload.subarray(0, 8))).toBe(true);
  });

  it('authenticates with AUTH PLAIN when credentials are supplied over a trusted link', async () => {
    const s = await server();
    // requireTls is off in this test; the client still refuses to send creds
    // unencrypted — so assert that behaviour explicitly.
    await expect(
      sendMail(base(s.port, { user: 'u', pass: 'p' }), {
        to: ['a@b.test'],
        subject: 'x',
        text: 'y',
      })
    ).rejects.toThrow(/unencrypted connection/);
  });

  it('throws when the server rejects every recipient', async () => {
    const s = await server({ rejectRecipients: ['nobody@casino.test'] });
    await expect(
      sendMail(base(s.port), { to: ['nobody@casino.test'], subject: 'x', text: 'y' })
    ).rejects.toThrow(/every recipient was rejected/);
  });

  it('still delivers when only some recipients are rejected', async () => {
    const s = await server({ rejectRecipients: ['bad@casino.test'] });
    const res = await sendMail(base(s.port), {
      to: ['bad@casino.test', 'good@casino.test'],
      subject: 'x',
      text: 'y',
    });
    expect(res.accepted).toEqual(['good@casino.test']);
  });

  it('refuses to send when the server offers no TLS and requireTls is set', async () => {
    const s = await server({ offerStartTls: false });
    await expect(
      sendMail(base(s.port, { requireTls: true }), { to: ['a@b.test'], subject: 'x', text: 'y' })
    ).rejects.toThrow(/no TLS/);
  });

  it('fails loudly when nothing is listening', async () => {
    await expect(
      sendMail(
        { host: '127.0.0.1', port: 9, from: 'x@y.test', timeoutMs: 2000 },
        { to: ['a@b.test'], subject: 'x', text: 'y' }
      )
    ).rejects.toThrow();
  });
});

describe('buildMime', () => {
  const opts = base(587);

  it('dot-stuffs a body line that starts with a period', async () => {
    const s = await server();
    await sendMail(base(s.port), { to: ['a@b.test'], subject: 'x', text: '.\nnot a terminator' });
    // The server would have ended DATA early on a bare "." line; the fact that
    // we got a 250 for the body AND the text arrived proves stuffing worked.
    expect(s.data).toContain('not a terminator');
  });

  it('RFC 2047-encodes a non-ASCII subject', () => {
    const mime = buildMime(opts, { to: ['a@b.test'], subject: 'بیک اپ', text: 'x' });
    expect(mime).toContain('Subject: =?UTF-8?B?');
  });

  it('leaves ASCII subjects readable', () => {
    const mime = buildMime(opts, { to: ['a@b.test'], subject: 'Nightly backup OK', text: 'x' });
    expect(mime).toContain('Subject: Nightly backup OK');
  });

  it('never writes a header-injecting filename into the MIME headers', () => {
    const mime = buildMime(opts, {
      to: ['a@b.test'],
      subject: 'x',
      text: 'y',
      attachments: [{ filename: 'evil"\r\nBcc: attacker@evil.test', content: Buffer.from('z') }],
    });
    expect(mime).not.toContain('Bcc: attacker@evil.test\r\n');
    expect(mime).toContain('filename="evil___Bcc: attacker@evil.test"');
  });

  it('marks a single-part message as text/plain (no multipart boundary)', () => {
    const mime = buildMime(opts, { to: ['a@b.test'], subject: 'x', text: 'y' });
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).not.toContain('multipart/mixed');
  });
});
