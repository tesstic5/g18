// apps/web/src/app/panel/recovery/page.tsx — Account Recovery console.
'use client';
import { RecoveryPanel } from '../../../components/admin/recovery';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Account Recovery" />
      <RecoveryPanel />
    </div>
  );
}
