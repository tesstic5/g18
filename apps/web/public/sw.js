// Service worker: cache only immutable/static assets. Application HTML, RSC,
// API, sockets, and admin/authenticated pages are never stored.
//
// The previous `/games/` prefix rule treated `/games/dice` HTML as an image and
// served it cache-first across deployments. nginx applied the same seven-day
// cache, pairing old HTML with removed Next chunks and causing ChunkLoadError.
const CACHE_VERSION = '2w2p-assets-v7-20260817';
const CACHE_NAME = `2w2p-${CACHE_VERSION}`;
const PRECACHE = ['/offline', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isStaticMedia(pathname) {
  if (!/^\/(games\/[^/]+\/|sounds\/|icons\/)/.test(pathname)) return false;
  return /\.(?:avif|gif|ico|jpe?g|mp3|ogg|png|svg|webp|wav)$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API/socket traffic.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;

  // Hashed Next chunks are network-first, cache only successful responses as an
  // offline fallback. A deployment can never prefer an old chunk over network.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  // Cache-first is limited to files with an explicit static-media extension.
  // `/games/dice` does not match; `/games/dice/thumbnail.webp` does.
  if (isStaticMedia(url.pathname)) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
    );
    return;
  }

  // Navigations are always fresh and are never written to cache. Offline users
  // receive only the dedicated offline shell; no private/admin page is replayed.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match('/offline')) || Response.error()
      )
    );
  }
});
