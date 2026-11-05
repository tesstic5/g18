// apps/web/src/app/panel/settings/email/page.tsx
// Email (SMTP) settings live here now, not at the bottom of Backup & Restore.
'use client';
import { SmtpSettings } from '../../../../components/admin/smtp-settings';
import { PageHeader } from '../../../../components/admin/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Email Settings" />
      <SmtpSettings />
    </div>
  );
}
