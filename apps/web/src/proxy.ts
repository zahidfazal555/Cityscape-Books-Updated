import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PAGES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/session',
];

/**
 * Per-request CSP nonce (ENGINEERING-STANDARDS §2) and a redirect to sign-in for app pages when
 * there is no session cookie at all. Real session checks happen on the server for every
 * page and API call; this is only routing.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  // The refresh cookie is scoped to /api/v1/auth, so pages cannot see it. A device cookie means
  // this browser signed in before: try a silent refresh first, else go to sign-in.
  const seenBefore = request.cookies.has('csd_dev');
  if (!PUBLIC_PAGES.some((p) => pathname.startsWith(p)) && !request.cookies.has('csd_at')) {
    const target = seenBefore ? '/session' : '/login';
    const url = new URL(target, request.url);
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ''}`,
    // style="" attributes (set by next/image and the route announcer) cannot carry a nonce.
    // They cannot run script; <style> elements stay nonce-locked above.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-pathname', `${pathname}${search}`);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|brand/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
