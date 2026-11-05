// apps/api/src/services/alertsMail.ts
//
// The email leg of an alert. Deliberately thin and lazily imported from
// monitoring.ts so that:
//   • an unconfigured SMTP (a fresh install) can never affect alerting, and
//   • importing the mail stack never happens on a request path that is not
//     actually sending mail.
//
// Reuses the admin-panel SMTP settings (and the SMTP_* environment fallback)
// that the nightly backup already relies on — no second configuration to keep
// in sync.
import { sendMail } from '../lib/smtp';
import { resolveSmtp } from './backupDelivery';
import type { AlertSeverity } from './monitoring';

export interface AlertMailInput {
  kind: string;
  severity: AlertSeverity;
  message: string;
  data?: Record<string, unknown>;
}

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  critical: 'CRITICAL',
};

/** Never let an alert email throw — the caller is already fire-and-forget. */
export async function sendAlertEmail(input: AlertMailInput): Promise<void> {
  const { smtp, recipients } = await resolveSmtp();
  if (!smtp || recipients.length === 0) return;

  const label = SEVERITY_LABEL[input.severity] ?? 'ALERT';
  const detail = input.data
    ? Object.entries(input.data)
        .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('\n')
    : '';

  const body = [
    `${label} — ${input.kind}`,
    '',
    input.message,
    '',
    detail,
    '',
    `Platform: ${process.env.NEXT_PUBLIC_PLATFORM_NAME || 'casino'}`,
    `Raised:   ${new Date().toISOString()}`,
    '',
    'This alert is also recorded under Panel → Monitoring.',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  await sendMail(smtp, {
    to: recipients,
    // The severity is in the SUBJECT so it is visible in a phone notification
    // without opening the mail.
    subject: `[${label}] ${input.kind}`,
    text: body,
  });
}
