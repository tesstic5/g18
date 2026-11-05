// apps/web/src/app/panel/backup/page.tsx — Backup & Restore (D-062)
'use client';
import { BackupPanel } from '../../../components/admin/backup';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Backup & Restore" />
      <BackupPanel />
    </div>
  );
}
