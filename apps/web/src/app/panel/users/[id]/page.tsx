// apps/web/src/app/panel/users/[id]/page.tsx — user detail (v4: fund, suspend, activity)
'use client';
import { useParams } from 'next/navigation';
import { UserDetail } from '../../../../components/admin/GameConfigEditor';

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <UserDetail userId={id} />;
}
