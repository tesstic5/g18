// apps/web/src/app/panel/users/page.tsx — player management (D-068)
'use client';
import { UsersPanel } from '../../../components/admin/users';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader
        title="Players"
        subtitle="Search, inspect wallets, credit or deduct balances, suspend or activate accounts."
      />
      <UsersPanel />
    </div>
  );
}
