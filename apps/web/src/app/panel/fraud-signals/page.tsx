// apps/web/src/app/panel/fraud-signals/page.tsx
'use client';
import { FraudSignalsPanel } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Fraud Signals" />
      <FraudSignalsPanel />
    </div>
  );
}
