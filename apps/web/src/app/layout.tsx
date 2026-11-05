// apps/web/src/app/layout.tsx — root layout: fonts (docs/21 preload), providers, toaster
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Inter, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Toaster } from '../lib/toast';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.FRONTEND_URL ||
      'https://2win2play.com'
  ),
  title: { default: '2 Win 2 Play — Casino Games', template: '%s · 2 Win 2 Play' },
  description: 'Play instant casino games. Crash, Mines, Plinko and more.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: '2 Win 2 Play',
    statusBarStyle: 'black-translucent',
  },
  applicationName: '2 Win 2 Play',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0f',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading x-nonce here is what lets Next attach the middleware nonce to its
  // own inline hydration scripts. Do not remove even if it looks unused.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${inter.variable} ${jakarta.variable} ${jetbrains.variable}`}
    >
      <body className="font-sans bg-layer-floor text-primary" data-nonce={nonce}>
        <Providers>
          <Toaster
            position="top-center"
            containerStyle={{ top: 70 }}
            toastOptions={{
              duration: 3000,
              style: {
                background: 'var(--bg-elevated)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '8px',
                fontSize: '14px',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                padding: '12px 16px',
                maxWidth: '320px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              },
            }}
          />
          {children}
        </Providers>
      </body>
    </html>
  );
}
