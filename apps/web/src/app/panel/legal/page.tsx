// apps/web/src/app/panel/legal/page.tsx
'use client';
import { LegalEditor } from '../../../components/admin/sections';
import { PageHeader } from '../../../components/admin/ui';
export default function Page() {
  return (
    <div>
      <PageHeader title="Legal Pages" />
      <LegalEditor />
    </div>
  );
}
