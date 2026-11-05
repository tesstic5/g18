// apps/web/src/app/panel/deposits/page.tsx
'use client';
import { DepositsQueue } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Deposit Queue" />
      <DepositsQueue />
    </div>
  );
}
