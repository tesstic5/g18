// apps/web/src/app/panel/managers/page.tsx
'use client';
import { ManagersPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Managers" />
      <ManagersPanel />
    </div>
  );
}
