// apps/web/src/app/panel/referral-users/page.tsx
'use client';
import { ReferralUsersPanel } from '../../../components/admin/referral-users';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Referral Users" />
      <ReferralUsersPanel />
    </div>
  );
}
