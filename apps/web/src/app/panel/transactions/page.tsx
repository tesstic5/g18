// apps/web/src/app/panel/transactions/page.tsx — money ledger (D-068)
'use client';
import { TransactionsPanel } from '../../../components/admin/transactions';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle="Every rupee that moves — bets, wins, deposits, withdrawals, bonuses and admin adjustments. Filter and export to CSV."
      />
      <TransactionsPanel />
    </div>
  );
}
