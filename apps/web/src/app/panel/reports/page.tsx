// apps/web/src/app/panel/reports/page.tsx
'use client';
import { ReportsPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Reports" />
      <ReportsPanel />
    </div>
  );
}
