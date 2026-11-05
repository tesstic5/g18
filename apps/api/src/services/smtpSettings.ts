// apps/api/src/services/smtpSettings.ts — admin-managed SMTP configuration.
//
// The admin panel can configure a mail account (Gmail app password, Brevo,
// Mailgun, the host's own relay…) without a redeploy. Two rules govern this
// module, because the values are secrets:
//
//  1. The password is ENCRYPTED AT REST (ENCRYPTION_KEY via crypto-utils) and is
//     NEVER returned by any read path — the panel sees a mask and a
//     "is it set?" flag instead.
//  2. Nothing here throws on bad data. A broken SMTP config must degrade to
//     "email is off", never to a crashing backup job or a 500 on settings read.
//
// DB settings win over SMTP_* environment variables; the env vars remain as the
// deploy-time fallback for stacks that prefer them.
import { encryptJson, decryptJson } from '../lib/crypto-utils';
import { smtpFromEnv, type SmtpOptions } from './backupDelivery';

/** Returned instead of the real password. Never persisted as a value. */
export const SMTP_PASSWORD_MASK = '••••••••';
export const SMTP_PASSWORD_KEY = 'smtp_password';

/** Keys the panel may write, and their maximum lengths. */
export const SMTP_STRING_KEYS: Record<string, number> = {
  smtp_host: 255,
  smtp_user: 320,
  smtp_from: 320,
  backup_email_to: 1024, // comma-separated list
  smtp_tls_servername: 255,
  smtp_password: 512,
};

export const SMTP_BOOLEAN_KEYS = [
  'smtp_secure',
  'smtp_require_tls',
  'smtp_allow_self_signed',
  'backup_email_enabled',
] as const;

export const SMTP_PORT_RANGE: [number, number] = [1, 65535];

/**
 * The master switch. Kept as a named helper so the panel's "Send test email"
 * can tell "you turned delivery off" apart from "you have not configured it",
 * instead of showing both cases as "SMTP is not configured yet".
 */
export function emailBackupEnabled(settings: Record<string, unknown>): boolean {
  return settings.backup_email_enabled !== false;
}

// A hostname, IPv4, or bracketed IPv6 — no scheme, no port, no spaces.
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;

export function splitRecipients(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validate an SMTP settings patch. Returns a human-readable problem, or null
 * when the patch is acceptable. Only inspects keys it owns.
 */
export function validateSmtpPatch(body: Record<string, unknown>): string | null {
  for (const [key, max] of Object.entries(SMTP_STRING_KEYS)) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value !== 'string') return `${key} must be a string`;
    if (value.length > max) return `${key} must be at most ${max} characters`;
    // The mask means "unchanged" — it is stripped before persisting.
    if (key === SMTP_PASSWORD_KEY && (value === SMTP_PASSWORD_MASK || value === '')) continue;

    if (key === 'smtp_host' && value !== '') {
      if (value.includes('://')) {
        return 'smtp_host must be a hostname only — remove the http:// or https:// prefix';
      }
      if (value.includes(':')) {
        return 'smtp_host must be a hostname only — put the port in the port field (e.g. smtp.gmail.com + 587)';
      }
      if (!HOST_RE.test(value)) return `${value} does not look like a valid hostname`;
    }
    if (key === 'smtp_from' && value !== '' && !EMAIL_RE.test(value)) {
      return 'smtp_from must be an email address (e.g. backups@yourdomain.com)';
    }
    if (key === 'smtp_user' && value !== '' && !EMAIL_RE.test(value) && !HOST_RE.test(value)) {
      return 'smtp_user must be an email address or username';
    }
    if (key === 'backup_email_to' && value !== '') {
      const bad = splitRecipients(value).filter((r) => !EMAIL_RE.test(r));
      if (bad.length) return `not a valid email address: ${bad.join(', ')}`;
    }
  }

  if ('smtp_port' in body) {
    const n = Number(body.smtp_port);
    if (!Number.isInteger(n) || n < SMTP_PORT_RANGE[0] || n > SMTP_PORT_RANGE[1]) {
      return `smtp_port must be a whole number between ${SMTP_PORT_RANGE[0]} and ${SMTP_PORT_RANGE[1]}`;
    }
  }

  for (const key of SMTP_BOOLEAN_KEYS) {
    if (key in body && typeof body[key] !== 'boolean') return `${key} must be true or false`;
  }

  return null;
}

/**
 * Transform a validated patch into the rows to persist: the password is
 * encrypted, and a mask/blank value is dropped entirely so saving the form
 * without retyping the password does not erase it.
 */
export function prepareSmtpPatch(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === SMTP_PASSWORD_KEY) {
      const v = String(value ?? '');
      if (v === SMTP_PASSWORD_MASK || v === '') continue; // unchanged
      out[key] = encryptJson(v);
      continue;
    }
    if (key in SMTP_STRING_KEYS) {
      out[key] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Decrypt a stored password. Returns undefined (never throws) on any failure. */
function readPassword(settings: Record<string, unknown>): string | undefined {
  const stored = settings[SMTP_PASSWORD_KEY];
  if (typeof stored !== 'string' || stored === '') return undefined;
  try {
    const value = decryptJson<unknown>(stored);
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    // ENCRYPTION_KEY changed, or the row was written by another deployment.
    console.warn('[smtp] stored password could not be decrypted — re-enter it in Settings');
    return undefined;
  }
}

/**
 * Replace the stored password with a mask and report whether a USABLE one
 * exists, so the panel can render "saved" state without the secret ever
 * crossing the wire.
 *
 * "Usable" means decryptable: after restoring a backup that was made with a
 * different ENCRYPTION_KEY, the row is present but unreadable. Reporting it as
 * saved would be a lie that only surfaces when the nightly email silently stops.
 */
export function maskSmtpSettings(
  settings: Record<string, unknown>
): Record<string, unknown> & { smtp_password_set: boolean; smtp_password_unreadable?: boolean } {
  const stored = settings[SMTP_PASSWORD_KEY];
  if (!stored) {
    return { ...settings, [SMTP_PASSWORD_KEY]: '', smtp_password_set: false };
  }
  const readable = readPassword(settings) !== undefined;
  return {
    ...settings,
    [SMTP_PASSWORD_KEY]: SMTP_PASSWORD_MASK,
    smtp_password_set: readable,
    ...(readable ? {} : { smtp_password_unreadable: true }),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Build SMTP options from settings, falling back to the environment for any
 * field the admin left blank. Returns null when email is not configured (or was
 * switched off), which callers treat as "skip quietly".
 */
export function smtpFromSettings(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): SmtpOptions | null {
  // Master switch: the admin can pause delivery without deleting the config.
  if (!emailBackupEnabled(settings)) return null;

  const envOpts = smtpFromEnv(env);
  const host = str(settings.smtp_host) || envOpts?.host || '';
  const from = str(settings.smtp_from) || str(settings.smtp_user) || envOpts?.from || '';
  if (!host || !from) return null;

  const portRaw = Number(settings.smtp_port);
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : envOpts?.port ?? 587;

  const secureSetting = settings.smtp_secure;
  const secure = typeof secureSetting === 'boolean' ? secureSetting : port === 465;

  const user = str(settings.smtp_user) || envOpts?.user || undefined;
  const pass = readPassword(settings) ?? envOpts?.pass ?? undefined;

  const requireTlsSetting = settings.smtp_require_tls;
  const allowSelfSignedSetting = settings.smtp_allow_self_signed;

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    requireTls:
      typeof requireTlsSetting === 'boolean' ? requireTlsSetting : envOpts?.requireTls ?? true,
    rejectUnauthorized:
      typeof allowSelfSignedSetting === 'boolean'
        ? !allowSelfSignedSetting
        : envOpts?.rejectUnauthorized ?? true,
    tlsServername: str(settings.smtp_tls_servername) || envOpts?.tlsServername || undefined,
    timeoutMs: envOpts?.timeoutMs ?? 30_000,
  };
}

/** Recipients for backup mail: settings first, then BACKUP_EMAIL_TO. */
export function recipientsFromSettings(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const fromSettings = splitRecipients(settings.backup_email_to);
  if (fromSettings.length) return fromSettings;
  return splitRecipients(env.BACKUP_EMAIL_TO);
}

/** True when the panel should show the setup as complete. */
export function smtpIsConfigured(settings: Record<string, unknown>, env = process.env): boolean {
  return smtpFromSettings(settings, env) !== null && recipientsFromSettings(settings, env).length > 0;
}
