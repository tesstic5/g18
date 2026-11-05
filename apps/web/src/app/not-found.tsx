// apps/web/src/app/not-found.tsx — friendly 404 (docs/19 §3 empty states)
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-layer-floor px-6 text-center gap-4">
      <span className="text-6xl">🎮</span>
      <h1 className="t-title text-primary">Page not found</h1>
      <p className="t-body text-secondary max-w-sm">
        The page you&apos;re looking for doesn&apos;t exist or was moved.
      </p>
      <Link href="/" className="btn-primary px-8">
        Browse Games
      </Link>
    </div>
  );
}
