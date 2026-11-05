// apps/web/src/app/panel/faqs/page.tsx
'use client';
import { FaqManager } from '../../../components/admin/FaqManager';
import { PageHeader } from '../../../components/admin/ui';

export default function Page() {
  return (
    <div>
      <PageHeader
        title="FAQs"
        subtitle="Categories and articles players see on Support. English is required; Urdu is shown when the player’s language is Urdu."
      />
      <FaqManager />
    </div>
  );
}
