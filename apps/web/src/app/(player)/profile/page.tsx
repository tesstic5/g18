// apps/web/src/app/(player)/profile/page.tsx — profile (D-064/D-067: login guard)
'use client';
import { useEffect } from 'react';
import { useAuthStore } from '../../../stores';
import { ProfilePage } from '../../../components/pages-extras';

export default function Page() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);

  // Not logged in → send to login (and return here after). Two triggers so it
  // can never hang: hydration completes, or a 2.5s safety timeout.
  useEffect(() => {
    if (user) return;
    if (hydrated) {
      window.location.href = `/login?redirect=${encodeURIComponent('/profile')}`;
      return;
    }
    const t = setTimeout(() => {
      window.location.href = `/login?redirect=${encodeURIComponent('/profile')}`;
    }, 2500);
    return () => clearTimeout(t);
  }, [hydrated, user]);

  if (!user)
    return (
      <div className="min-h-[50dvh] flex items-center justify-center">
        <div className="h-6 w-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      </div>
    );
  return <ProfilePage />;
}
