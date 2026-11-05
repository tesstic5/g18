// apps/web/src/app/(player)/legal/[slug]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import { LegalPageView } from '../../../../components/pages-extras';
export default function Page() {
  const { slug } = useParams<{ slug: string }>();
  return <LegalPageView slug={slug} />;
}
