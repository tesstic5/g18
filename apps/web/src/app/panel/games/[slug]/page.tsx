// apps/web/src/app/panel/games/[slug]/page.tsx — game config editor (live validation)
'use client';
import { useParams } from 'next/navigation';
import { GameConfigEditor } from '../../../../components/admin/GameConfigEditor';

export default function GameEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <div>
      <h1 className="t-title text-primary mb-6">Game Controls — {slug}</h1>
      <GameConfigEditor slug={slug} />
    </div>
  );
}
