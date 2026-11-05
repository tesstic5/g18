// apps/web/src/app/panel/settings/page.tsx
'use client';
import { SettingsPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsPanel />
    </div>
  );
}
