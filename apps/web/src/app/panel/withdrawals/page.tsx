// apps/web/src/app/panel/withdrawals/page.tsx
'use client';
import { WithdrawalsQueue } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Withdrawal Queue" />
      <WithdrawalsQueue />
    </div>
  );
}
