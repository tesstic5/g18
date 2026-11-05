// apps/web/src/app/panel/payment-accounts/page.tsx — structured account management (D-068)
'use client';
import { PaymentAccountsPanel } from '../../../components/admin/payment-accounts';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader
        title="Payment Accounts"
        subtitle="The wallets players pay into for deposits — no JSON needed, plain fields only."
      />
      <PaymentAccountsPanel />
    </div>
  );
}
