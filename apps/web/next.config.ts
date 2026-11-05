// apps/web/next.config.ts — canonical v7 §1, adapted for Next 16
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',

  // The sandbox/preview loads the site from a proxied cross-origin host
  // ({port}-{sandboxId}.e2b.app). Next 16 blocks dev resources from unknown
  // origins by default, which breaks hydration — allow the preview subdomains.
  // NOTE: bare '*' is rejected by Next 16's matcher; '*.e2b.app' matches the
  // sandbox preview hosts. (Prod standalone is unaffected — dev-only check.)
  allowedDevOrigins: ['*.e2b.app'],

  images: {
    formats: ['image/webp', 'image/avif'],
    deviceSizes: [375, 430, 768, 1024, 1440],
    imageSizes: [16, 32, 64, 128, 256],
    minimumCacheTTL: 604800,
    dangerouslyAllowSVG: false,
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          // M-19: the nginx security policy only exists when the nginx proxy is
          // deployed — direct Next/Dokploy variants had none. Mirror the
          // baseline headers here so every deployment shape gets them.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // CSP is set per-request by apps/web/src/proxy.ts (script nonce).
          // A static CSP here would fight the nonce header. nginx must not add
          // a second Content-Security-Policy either.
        ],
      },
      {
        source: '/games/:slug/thumbnail',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=604800, immutable' }],
      },
    ];
  },

  async redirects() {
    return [{ source: '/admin', destination: '/panel', permanent: true }];
  },

  // Proxy API + socket to the backend so the browser can use SAME-ORIGIN URLs.
  // Dev/preview: backend on localhost:4000. Production (Docker): INTERNAL_API_URL
  // (http://api:4000/api/v1). This makes the container work with zero NEXT_PUBLIC_*
  // build args; if NEXT_PUBLIC_API_URL/WS_URL are set, the client prefers them.
  async rewrites() {
    const api = process.env.INTERNAL_API_URL || 'http://localhost:4000/api/v1';
    const base = api.replace(/\/api\/v1\/?$/, '');
    return [
      { source: '/api/v1/:path*', destination: `${api}/:path*` },
      // D-096 FIX: the socket.io-client always requests /socket.io/ (trailing
      // slash) but Next normalizes it with a 308 to /socket.io (no slash),
      // which engine.io 6.6.9 rejects (strict prefix match on '/socket.io/') →
      // 404 → the browser socket NEVER connected through the site (crash
      // ticks, notifications, deposit status and chat were all dead in the
      // browser). Re-add the trailing slash when forwarding to the API.
      // Order matters: the exact no-slash match must come FIRST so it wins.
      { source: '/socket.io', destination: `${base}/socket.io/` },
      { source: '/socket.io/:path*', destination: `${base}/socket.io/:path*` },
    ];
  },

  experimental: {
    optimizePackageImports: ['@tanstack/react-query'],
    // The built-in rewrite proxy (below) has a 30-SECOND timeout by default
    // (Next 16: server/lib/router-utils/proxy-request.js — `proxyTimeout ||
    // 30000`). Every /api/v1 request goes through it, so ANY long call died at
    // 30s with a bare "Request failed" in the panel — including the JSON backup
    // RESTORE, where the API deliberately budgets 15 minutes
    // (services/backup.ts RESTORE_TX_TIMEOUT_MS) and the browser client waits
    // the same 15 minutes. The uploaded bundle is also large (the export is
    // AES-GCM + base64, ~1.37x the plain JSON), so the body alone could outlast
    // 30s on a slow line.
    // 15 minutes: matches the server's restore budget, so the slowest supported
    // operation is not cut by the proxy in front of it.
    proxyTimeout: 15 * 60 * 1000,
  },

  // Environment exposed to client (D-017: PKR symbol; D-016: brand from env)
  env: {
    NEXT_PUBLIC_PLATFORM_NAME: process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play',
    NEXT_PUBLIC_PLATFORM_TAGLINE:
      process.env.NEXT_PUBLIC_PLATFORM_TAGLINE || 'Play. Win. Repeat.',
    NEXT_PUBLIC_CURRENCY_SYMBOL: process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨',
    NEXT_PUBLIC_BUILD_ID:
      process.env.NEXT_PUBLIC_BUILD_ID || process.env.GIT_SHA || 'dev',
  },
};

export default config;
