// apps/web/src/app/referral-panel/layout.tsx — referral agent console shell.
// Uses the same theme (globals.css) and surface classes as the admin panel.
import '../globals.css';

export default function ReferralPanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-layer-floor text-primary font-sans antialiased">
      {children}
    </div>
  );
}
