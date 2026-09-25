import { NextResponse, type NextRequest } from 'next/server';

/*
 * Per-request nonce Content-Security-Policy. Only scripts carrying this
 * request's nonce (Next.js attaches it to its own scripts and styles) and
 * what they load ('strict-dynamic') may run: an injected <script> or event
 * handler attribute is inert even if some future bug let markup through.
 *
 * connect-src: our own origin (the API is proxied at /api) plus the IdP
 * origins this deployment signs users in with (AUTH_CONNECT_SRC).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const connect = ["'self'", ...(process.env.AUTH_CONNECT_SRC ?? '').split(/\s+/).filter(Boolean)].join(' ');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Development only: Next's dev tools inject un-nonced styles.
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
};
