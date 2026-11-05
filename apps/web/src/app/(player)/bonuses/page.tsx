// apps/web/src/app/(player)/bonuses/page.tsx
'use client';
import { DailyCheckinCalendar } from '../../../components/pages-extras';
export default function Page() {
  return (
    <div className="px-4 py-6 max-w-md mx-auto space-y-4">
      <h1 className="t-title text-primary">Bonuses</h1>
      <DailyCheckinCalendar />
    </div>
  );
}
