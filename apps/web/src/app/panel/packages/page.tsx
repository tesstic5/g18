// apps/web/src/app/panel/packages/page.tsx — deposit top-up packages.
'use client';
import { PackagesPanel } from '../../../components/admin/packages';
import { PageHeader } from '../../../components/admin/ui';

export default function Page() {
  return (
    <div>
      <PageHeader
        title="Deposit Packages"
        subtitle="Top-up bundles shown on the deposit page — the screen players land on right after signing up. Bonus credit goes to the bonus wallet, so it must be wagered before it can be withdrawn."
      />
      <PackagesPanel />
    </div>
  );
}
