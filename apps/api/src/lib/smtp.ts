// apps/api/src/lib/smtp.ts — minimal SMTP client, ZERO dependencies.
//
// WHY hand-rolled: the platform ships no mailer, and adding one (nodemailer)
// would change pnpm-lock.yaml — every Dockerfile installs with
// `--frozen-lockfile`, so a dependency added without regenerating the lock
// fails the build. This covers exactly what backup delivery needs: implicit
// TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN, one text part + file
// attachments, and dot-stuffing.
//
// NOT a general-purpose mailer: no DKIM signing, no DSN, no pipelining.
import net from 'node:net';
import tls from 'node:tls';

export interface SmtpOptions {
  host: string;
  port: number;
  /** true = implicit TLS (usually 465). false = plain, upgraded via STARTTLS when offered. */
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Refuse to authenticate or send if the link is not encrypted. */
  requireTls?: boolean;
  /** Cert validation. Keep true in production; tests use false with self-signed certs. */
  rejectUnauthorized?: boolean;
  tlsServername?: string;
  timeoutMs?: number;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  replyTo?: string;
}

const CRLF = '\r\n';

/** Buffered line reader over a socket — resolves replies as they complete. */
class LineReader {
  private buf = '';
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private done = false;

  constructor(private socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w(line);
        } else {
          this.queue.push(line);
        }
      }
    });
    const finish = () => {
      this.done = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(null);
      }
    };
    socket.on('close', finish);
    socket.on('end', finish);
  }

  read(timeoutMs: number): Promise<string> {
    if (this.queue.length) return Promise.resolve(this.queue.shift() as string);
    if (this.done) return Promise.reject(new Error('connection closed by server'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`SMTP timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        if (line === null) reject(new Error('connection closed by server'));
        else resolve(line);
      };
    });
  }

  detach(): void {
    this.done = true;
    this.waiter = null;
  }
}

interface Reply {
  code: number;
  text: string;
}

async function readReply(reader: LineReader, timeoutMs: number): Promise<Reply> {
  const first = await reader.read(timeoutMs);
  const code = Number(first.slice(0, 3));
  if (!Number.isFinite(code)) throw new Error(`malformed SMTP reply: ${first}`);
  const lines = [first];
  // Multiline: "250-..." continues, "250 ..." ends.
  let line = first;
  while (line.startsWith(`${code}-`)) {
    line = await reader.read(timeoutMs);
    lines.push(line);
  }
  return { code, text: lines.join('\n') };
}

function expectCode(reply: Reply, ok: number[], step: string): void {
  if (!ok.includes(reply.code)) {
    throw new Error(`SMTP ${step} failed: ${reply.code} ${reply.text}`);
  }
}

/** RFC 5322 requires lines beginning with "." to be doubled. */
function dotStuff(text: string): string {
  return text.replace(/\r?\n\./g, `\n..`).replace(/^\./, '..');
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** Non-ASCII subjects must be RFC 2047 encoded. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '_').slice(0, 200);
}

export function buildMime(opts: SmtpOptions, msg: MailMessage): string {
  const boundary = `----casino-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${msg.to.join(', ')}`,
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
  ];

  const body = [msg.text.split('\n').join(CRLF)];
  const attachments = msg.attachments ?? [];

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      ...body,
    ].join(CRLF);
  }

  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    ...body,
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType ?? 'application/octet-stream'}; name="${sanitizeFilename(att.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${sanitizeFilename(att.filename)}"`,
      '',
      // 76-char lines keep every intermediary happy.
      att.content.toString('base64').replace(/(.{76})/g, `$1${CRLF}`).replace(/\r\n$/, '')
    );
  }
  parts.push(`--${boundary}--`);

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
  ].join(CRLF);
}

/**
 * Send one message. Resolves with the RCPT addresses the server accepted;
 * throws on any protocol/auth failure so the caller can decide whether a
 * missing backup email is fatal.
 */
export async function sendMail(opts: SmtpOptions, msg: MailMessage): Promise<{ accepted: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const secure = opts.secure ?? opts.port === 465;

  let socket: net.Socket = secure
    ? tls.connect({
        host: opts.host,
        port: opts.port,
        servername: opts.tlsServername ?? opts.host,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      })
    : net.connect({ host: opts.host, port: opts.port });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMTP connect timeout (${opts.host}:${opts.port})`)), timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  let reader = new LineReader(socket);
  const write = (line: string) => socket.write(line + CRLF);

  try {
    expectCode(await readReply(reader, timeoutMs), [220], 'greeting');

    write(`EHLO casino-backup`);
    let ehlo = await readReply(reader, timeoutMs);
    expectCode(ehlo, [250], 'EHLO');
    let caps = ehlo.text.toUpperCase();
    let encrypted = secure;

    // STARTTLS upgrade on a plaintext connection.
    if (!secure && caps.includes('STARTTLS')) {
      write('STARTTLS');
      expectCode(await readReply(reader, timeoutMs), [220], 'STARTTLS');
      reader.detach();
      socket = tls.connect({
        socket: socket as net.Socket,
        servername: opts.tlsServername ?? opts.host,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve());
        socket.once('error', reject);
      });
      reader = new LineReader(socket);
      encrypted = true;
      write(`EHLO casino-backup`);
      ehlo = await readReply(reader, timeoutMs);
      expectCode(ehlo, [250], 'EHLO (after STARTTLS)');
      caps = ehlo.text.toUpperCase();
    }

    if (opts.requireTls && !encrypted) {
      throw new Error('refusing to send: server offered no TLS and requireTls is set');
    }

    // AUTH — only over an encrypted link when credentials exist.
    if (opts.user && opts.pass) {
      if (!encrypted) throw new Error('refusing to send credentials over an unencrypted connection');
      if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        write(`AUTH PLAIN ${b64(`\0${opts.user}\0${opts.pass}`)}`);
        expectCode(await readReply(reader, timeoutMs), [235], 'AUTH PLAIN');
      } else {
        write('AUTH LOGIN');
        expectCode(await readReply(reader, timeoutMs), [334], 'AUTH LOGIN');
        write(b64(opts.user));
        expectCode(await readReply(reader, timeoutMs), [334], 'AUTH LOGIN user');
        write(b64(opts.pass));
        expectCode(await readReply(reader, timeoutMs), [235], 'AUTH LOGIN pass');
      }
    }

    write(`MAIL FROM:<${opts.from}>`);
    expectCode(await readReply(reader, timeoutMs), [250], 'MAIL FROM');

    const accepted: string[] = [];
    for (const rcpt of msg.to) {
      write(`RCPT TO:<${rcpt}>`);
      const reply = await readReply(reader, timeoutMs);
      if (reply.code === 250 || reply.code === 251) accepted.push(rcpt);
    }
    if (accepted.length === 0) throw new Error('every recipient was rejected');

    write('DATA');
    expectCode(await readReply(reader, timeoutMs), [354], 'DATA');
    socket.write(dotStuff(buildMime(opts, msg)) + `${CRLF}.${CRLF}`);
    expectCode(await readReply(reader, timeoutMs), [250], 'message body');

    write('QUIT');
    return { accepted };
  } finally {
    reader.detach();
    socket.destroy();
  }
}
