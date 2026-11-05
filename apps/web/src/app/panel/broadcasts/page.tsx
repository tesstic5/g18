// apps/web/src/app/panel/broadcasts/page.tsx
'use client';
import { BroadcastsPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Broadcasts" />
      <BroadcastsPanel />
    </div>
  );
}
