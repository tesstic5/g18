// apps/web/src/app/panel/audit-log/page.tsx
'use client';
import { AuditLogPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Audit Log" />
      <AuditLogPanel />
    </div>
  );
}
