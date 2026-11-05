// apps/web/src/app/offline/page.tsx — offline fallback page (docs/19 §12)
'use client';

export default function OfflinePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-dvh bg-layer-floor p-8 text-center">
      <img
        src="/icons/logo.svg"
        alt="2 Win 2 Play"
        className="w-20 h-20 mb-6 drop-shadow-[0_8px_24px_rgba(245,200,66,0.25)]"
      />
      <div className="text-6xl mb-6">📡</div>
      <h1 className="t-title text-primary mb-3">You&apos;re Offline</h1>
      <p className="t-body text-secondary mb-8 max-w-sm">
        Check your internet connection and try again. Your balance and game history are
        safe.
      </p>
      <button onClick={() => window.location.reload()} className="btn-primary px-8">
        Try Again
      </button>
    </div>
  );
}
