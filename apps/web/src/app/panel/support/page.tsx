// apps/web/src/app/panel/support/page.tsx
'use client';
import { SupportInbox } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Support Inbox" />
      <SupportInbox />
    </div>
  );
}
