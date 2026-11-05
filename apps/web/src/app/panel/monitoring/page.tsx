// apps/web/src/app/panel/monitoring/page.tsx — Monitoring & Alerts console.
'use client';
import { MonitoringPanel } from '../../../components/admin/monitoring';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Monitoring" />
      <MonitoringPanel />
    </div>
  );
}
