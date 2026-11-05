'use client';
import { useEffect } from 'react';

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'unknown';

/** Root recovery page for render errors that escape route/component boundaries. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const report = {
      name: error.name,
      message: error.message || 'Unknown client render error',
      digest: error.digest,
      path: window.location.pathname,
      buildId: BUILD_ID,
      userAgent: navigator.userAgent,
    };
    void fetch('/api/v1/errors', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {});
  }, [error]);

  const hardReset = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((registration) => registration.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch {
      // Best-effort recovery; a reload still works when cache APIs are blocked.
    }
    const url = new URL(window.location.href);
    url.searchParams.set('fresh', Date.now().toString());
    window.location.replace(url.toString());
  };

  return (
    <html lang="en" data-theme="dark">
      <body
        style={{
          margin: 0,
          background: '#0a0a0f',
          color: '#fff',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        <div
          style={{
            minHeight: '100dvh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{ textAlign: 'center', maxWidth: 420 }}>
            <img
              src="/icons/logo.svg"
              alt="2 Win 2 Play"
              style={{ width: 88, height: 88, margin: '0 auto 20px', display: 'block' }}
            />
            <h1 style={{ fontSize: 22, margin: '0 0 8px', fontWeight: 700 }}>
              Something went wrong
            </h1>
            <p
              style={{
                fontSize: 14,
                color: '#8b8b9e',
                lineHeight: 1.6,
                margin: '0 0 8px',
              }}
            >
              The page hit an unexpected error. It has been reported; no bet should be
              retried until your balance and history are checked.
            </p>
            <p style={{ fontSize: 11, color: '#666678', margin: '0 0 24px' }}>
              Reference: {error.digest || 'client'} · build {BUILD_ID}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  height: 48,
                  borderRadius: 10,
                  border: '1px solid rgba(0,230,136,0.3)',
                  background: 'linear-gradient(180deg,#00e688,#00b368)',
                  color: '#003d20',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Reload page
              </button>
              <button
                onClick={reset}
                style={{
                  height: 44,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#ddd',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Try rendering again
              </button>
              <button
                onClick={() => void hardReset()}
                style={{
                  height: 48,
                  borderRadius: 10,
                  border: '1px solid rgba(245,200,66,0.4)',
                  background: 'rgba(245,200,66,0.1)',
                  color: '#f5c842',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Clear cached assets & reload
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
