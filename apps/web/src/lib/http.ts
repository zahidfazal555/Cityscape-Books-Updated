import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { DomainError, type Actor } from '@csd/core';
import type { ClientInfo, Tokens } from '@csd/services';
import { env } from './env';
import { log } from './log';
import { services } from './server';

export const COOKIE = { access: 'csd_at', refresh: 'csd_rt', device: 'csd_dev' } as const;
const MAX_BODY_BYTES = 100_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestContext<P> {
  req: NextRequest;
  params: P;
  client: ClientInfo;
  /** Parsed JSON body (mutating requests only). */
  body: unknown;
}
export interface AuthedContext<P> extends RequestContext<P> {
  actor: Actor;
}

type RouteHandler<P> = (req: NextRequest, route: { params: Promise<P> }) => Promise<Response>;

/** An unauthenticated endpoint (sign-in, password reset). Still CSRF- and size-checked. */
export function publicApi<P = Record<string, never>>(
  fn: (ctx: RequestContext<P>) => Promise<unknown>,
): RouteHandler<P> {
  return (req, route) => run(req, route, async (ctx) => fn(ctx));
}

/**
 * Every authenticated endpoint goes through this: the session is verified on the server and
 * the handler receives the actor. Permission checks happen inside the services
 * (`authorize(...)`), so a route cannot forget them.
 */
export function api<P = Record<string, never>>(
  fn: (ctx: AuthedContext<P>) => Promise<unknown>,
): RouteHandler<P> {
  return (req, route) =>
    run(req, route, async (ctx) => {
      const token = req.cookies.get(COOKIE.access)?.value ?? bearer(req);
      if (!token) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
      const { actor } = await services().auth.authenticate(token);
      return fn({ ...ctx, actor });
    });
}

async function run<P>(
  req: NextRequest,
  route: { params: Promise<P> },
  fn: (ctx: RequestContext<P>) => Promise<unknown>,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (MUTATING.has(req.method)) assertSameOrigin(req);
    const body = MUTATING.has(req.method) ? await readJson(req) : undefined;
    const result = await fn({ req, params: await route.params, client: clientInfo(req), body });
    const res =
      result instanceof Response
        ? result
        : result === undefined
          ? new NextResponse(null, { status: 204 })
          : NextResponse.json(result);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.toJSON() },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    log('error', 'unhandled API error', {
      requestId,
      method: req.method,
      path: req.nextUrl.pathname,
      error,
    });
    return NextResponse.json(
      {
        error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

/** CSRF defence in depth (cookies are already SameSite=Strict): mutations must be same-origin. */
function assertSameOrigin(req: NextRequest): void {
  const expected = new URL(env().APP_URL).origin;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (origin ? origin === expected : site === 'same-origin') return;
  throw new DomainError('FORBIDDEN', 'Cross-site request refused.');
}

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) return {};
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new DomainError('VALIDATION', 'Request is too large.');
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    throw new DomainError('VALIDATION', 'Send JSON.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('VALIDATION', 'Request body is not valid JSON.');
  }
}

function bearer(req: NextRequest): string | undefined {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/** Client IP = the address added by our nearest trusted proxy, not a client-supplied one. */
function trustedIp(forwardedFor: string | null): string | null {
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const trusted = env().TRUSTED_PROXIES;
  if (trusted === 0 || hops.length < trusted) return null;
  const ip = hops[hops.length - trusted] ?? '';
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}

export function clientInfo(req: NextRequest): ClientInfo {
  return {
    ip: trustedIp(req.headers.get('x-forwarded-for')),
    userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
    deviceId: req.cookies.get(COOKIE.device)?.value ?? null,
  };
}

const secure = (): boolean => new URL(env().APP_URL).protocol === 'https:';

/** Sets the session cookies: httpOnly, SameSite=Strict, Secure on https. */
export function withSessionCookies(
  res: NextResponse,
  tokens: Tokens,
  deviceId: string | null,
): NextResponse {
  const base = { httpOnly: true, sameSite: 'strict' as const, secure: secure() };
  res.cookies.set(COOKIE.access, tokens.accessToken, { ...base, path: '/', maxAge: 15 * 60 });
  res.cookies.set(COOKIE.refresh, tokens.refreshToken, {
    ...base,
    path: '/api/v1/auth',
    expires: tokens.refreshExpiresAt,
  });
  if (!deviceId)
    res.cookies.set(COOKIE.device, randomUUID(), { ...base, path: '/', maxAge: 400 * 24 * 3600 });
  return res;
}

export function clearSessionCookies(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE.access, '', { path: '/', maxAge: 0 });
  res.cookies.set(COOKIE.refresh, '', { path: '/api/v1/auth', maxAge: 0 });
  return res;
}
