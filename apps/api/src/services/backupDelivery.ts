// apps/api/src/services/backupDelivery.ts — email the nightly encrypted backup.
//
// Design notes:
//   * The attachment is ALREADY encrypted twice over: exportJson() wraps the
//     bundle in AES-256-GCM with ENCRYPTION_KEY, and the worker additionally
//     seals it for the operator's public key (.cbk). A mailbox compromise
//     therefore leaks nothing readable.
//   * Email is best-effort: a failed send must NEVER fail the backup job (the
//     file on disk is the source of truth). Errors are returned, not thrown.
//   * Attachments are size-capped. Provider limits are usually ~25 MB and the
//     base64 encoding adds 33%, so an over-size backup sends a NOTICE instead —
//     the file stays on the server, where the operator can fetch or ship it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sendMail, type SmtpOptions, type MailAttachment } from '../lib/smtp';

export type { SmtpOptions };

/** Provider limits are typically 25 MB; base64 inflates by 4/3. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface DeliveryResult {
  status: 'sent' | 'skipped' | 'failed';
  /** why it was skipped/failed, or how it was sent */
  detail?: string;
  accepted?: string[];
}

/** Build SMTP options from the environment, or null when not configured. */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpOptions | null {
  const host = env.SMTP_HOST?.trim();
  const from = (env.SMTP_FROM || env.SMTP_USER)?.trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT) || 587;
  return {
    host,
    port,
    secure: env.SMTP_SECURE === 'true' || port === 465,
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from,
    requireTls: env.SMTP_REQUIRE_TLS !== 'false',
    // Self-signed internal relays need an explicit opt-out.
    rejectUnauthorized: env.SMTP_ALLOW_SELF_SIGNED !== 'true',
    tlsServername: env.SMTP_TLS_SERVERNAME?.trim() || undefined,
    timeoutMs: Number(env.SMTP_TIMEOUT_MS) || 30_000,
  };
}

/**
 * Resolve SMTP config the way the running system should: the admin panel's
 * stored settings first, environment variables as the fallback.
 *
 * Only used when the caller does not pass an explicit `env` — tests stay
 * hermetic, and the worker/panel path picks up live settings.
 *
 * Any failure while reading settings (DB hiccup, Redis down) degrades to the
 * env-only configuration rather than failing the caller.
 */
export async function resolveSmtp(): Promise<{
  smtp: SmtpOptions | null;
  recipients: string[];
}> {
  try {
    const { getSettings } = await import('./settings');
    const { smtpFromSettings, recipientsFromSettings } = await import('./smtpSettings');
    const settings = await getSettings();
    return {
      smtp: smtpFromSettings(settings),
      recipients: recipientsFromSettings(settings),
    };
  } catch (e) {
    console.warn('[smtp] settings unavailable, using environment only:', (e as Error).message);
    return { smtp: smtpFromEnv(), recipients: recipientsFromEnv() };
  }
}

/** Send a one-off message so an admin can verify their SMTP configuration. */
export async function sendTestEmail(opts: {
  to?: string;
  env?: NodeJS.ProcessEnv;
  send?: typeof sendMail;
  /** Override the resolved config (used by the panel to test UNSAVED values). */
  smtp?: SmtpOptions | null;
  /**
   * Explicit recipients that came with `smtp` (the panel sends the values the
   * admin just typed). Without this the unsaved-values test fell back to
   * BACKUP_EMAIL_TO and reported "no recipient" even though the form had one.
   */
  recipients?: string[];
  recipientOverride?: string;
} = {}): Promise<{ ok: true; accepted: string[] } | { ok: false; error: string }> {
  let smtp = opts.smtp ?? null;
  let recipients: string[] = opts.recipients ?? [];

  if (smtp) {
    if (recipients.length === 0) recipients = recipientsFromEnv(opts.env ?? process.env);
  } else if (opts.env) {
    smtp = smtpFromEnv(opts.env);
    if (recipients.length === 0) recipients = recipientsFromEnv(opts.env);
  } else {
    const resolved = await resolveSmtp();
    smtp = resolved.smtp;
    if (recipients.length === 0) recipients = resolved.recipients;
  }

  const to = opts.recipientOverride || opts.to || recipients[0];
  if (!smtp) return { ok: false, error: 'SMTP is not configured yet' };
  if (!to) return { ok: false, error: 'No recipient — add a "Send to" address' };

  try {
    const res = await (opts.send ?? sendMail)(smtp, {
      to: [to],
      subject: '[casino] SMTP test — email delivery works',
      text: [
        'This is a test message from your casino admin panel.',
        '',
        `Host:   ${smtp.host}:${smtp.port} (${smtp.secure ? 'implicit TLS' : 'STARTTLS if offered'})`,
        `From:   ${smtp.from}`,
        `Sent:   ${new Date().toISOString()}`,
        '',
        'If you can read this, the nightly encrypted backup will be emailed to you.',
      ].join('\n'),
    });
    return { ok: true, accepted: res.accepted };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Comma-separated BACKUP_EMAIL_TO, trimmed, blanks dropped. */
export function recipientsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BACKUP_EMAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes('@'));
}

export function sha256File(path: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function describe(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Email a finished backup. Never throws: the caller (a cron job) must not lose
 * a good backup because a mail server was down.
 */
export async function emailBackup(opts: {
  filePath: string;
  filename?: string;
  /** Skip the file read when the caller already knows the size. */
  bytes?: number;
  sha256?: string;
  /** Extra line for the body, e.g. row counts or the restore command. */
  note?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit SMTP config (skips resolution entirely — used by tests/scripts). */
  smtp?: SmtpOptions | null;
  /** Explicit recipients (used with `smtp`). */
  recipients?: string[];
  /** Injectable for tests. */
  send?: typeof sendMail;
}): Promise<DeliveryResult> {
  const env = opts.env;
  // Resolution order: explicit smtp/recipients (tests, scripts) > explicit env
  // > live panel settings with an environment fallback.
  const live = env || opts.smtp !== undefined ? null : await resolveSmtp();
  const smtp = opts.smtp ?? (env ? smtpFromEnv(env) : live!.smtp);
  const recipients = opts.recipients ?? (env ? recipientsFromEnv(env) : live!.recipients);

  if (!smtp) {
    return {
      status: 'skipped',
      detail: 'SMTP is not configured (Admin panel -> Backup -> Email delivery)',
    };
  }
  if (recipients.length === 0) {
    return { status: 'skipped', detail: 'no recipients configured for backup email' };
  }
  if (!fs.existsSync(opts.filePath)) {
    return { status: 'failed', detail: `backup file not found: ${opts.filePath}` };
  }

  const bytes = opts.bytes ?? fs.statSync(opts.filePath).size;
  const checksum = opts.sha256 ?? sha256File(opts.filePath);
  // `env` is optional: callers may pass an explicit `smtp` with no env at all
  // (scripts, tests). Reading env.BACKUP_EMAIL_MAX_BYTES unguarded crashed with
  // "Cannot read properties of undefined" in exactly that case.
  const maxBytes = Number(env?.BACKUP_EMAIL_MAX_BYTES) || DEFAULT_MAX_ATTACHMENT_BYTES;
  const filename = opts.filename ?? (opts.filePath.split(/[\\/]/).pop() || 'backup');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const tooBig = bytes > maxBytes;
  const body = [
    `Encrypted backup: ${filename}`,
    `Created:  ${stamp} UTC`,
    `Size:     ${describe(bytes)}`,
    `SHA-256:  ${checksum}`,
    '',
    tooBig
      ? `The file is larger than the ${describe(maxBytes)} attachment limit, so it was NOT attached.\n` +
        'It is on the server at the path shown above — download it over SSH/SFTP.'
      : 'The attachment is encrypted. It is unreadable without your backup private key.',
    '',
    'To restore it:',
    '  node scripts/backup-crypto.mjs decrypt --key backup-key.txt --in <file>.cbk --out backup.json',
    '  (then: Admin panel -> Backup & Restore, or pg_restore for a .dump)',
    '',
    'Keep backup-key.txt offline. Without it these backups cannot be recovered —',
    'by anyone, including us.',
    ...(opts.note ? ['', opts.note] : []),
  ].join('\n');

  const attachments: MailAttachment[] = tooBig
    ? []
    : [{ filename, content: fs.readFileSync(opts.filePath), contentType: 'application/octet-stream' }];

  try {
    const sender = opts.send ?? sendMail;
    const res = await sender(smtp, {
      to: recipients,
      subject: tooBig
        ? `[casino] Backup ${describe(bytes)} (too large to attach)`
        : `[casino] Encrypted backup ${describe(bytes)} — ${stamp.slice(0, 10)}`,
      text: body,
      attachments,
    });
    return { status: 'sent', detail: tooBig ? 'sent notice (no attachment)' : 'sent with attachment', accepted: res.accepted };
  } catch (e) {
    return { status: 'failed', detail: (e as Error).message };
  }
}
