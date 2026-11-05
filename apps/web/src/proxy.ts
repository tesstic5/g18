// apps/web/src/proxy.ts — per-request CSP nonce (replaces nginx 'unsafe-inline').
// Next 16 file convention: proxy.ts exporting `proxy` (middleware.ts is deprecated).
import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from './lib/csp';

export function proxy(request: NextRequest) {
  // Gateway launch serves its own restrictive, per-provider CSP from the API.
  // Applying the app's form-action 'self' here would block the hosted checkout.
  if (request.nextUrl.pathname.startsWith('/api/v1/payfast/launch/')) return NextResponse.next();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif)$).*)',
  ],
};
