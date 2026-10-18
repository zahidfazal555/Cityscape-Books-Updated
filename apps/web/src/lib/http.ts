import 'server-only';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { NextResponse, type NextRequest } from 'next/server';
import { DomainError, type Actor } from '@csd/core';
import type { ClientInfo, Tokens } from '@csd/services';
import { env } from './env';
import { log } from './log';
import { limits } from './rate-limit';
import { services } from './server';

export const COOKIE = { access: 'csd_at', refresh: 'csd_rt', device: 'csd_dev' } as const;
export const MAX_BODY_BYTES = 100_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Marks handlers built by api()/publicApi()/probe(); the route-guard test checks for it. */
export const GUARD = Symbol.for('csd.route-guard');
export type GuardKind = 'authenticated' | 'public' | 'probe';

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

type RouteHandler<P> = ((req: NextRequest, route: { params: Promise<P> }) => Promise<Response>) & {
  [GUARD]: GuardKind;
};

function tag<P>(
  kind: GuardKind,
  fn: (req: NextRequest, route: { params: Promise<P> }) => Promise<Response>,
): RouteHandler<P> {
  return Object.assign(fn, { [GUARD]: kind });
}

/** An unauthenticated endpoint (sign-in, password reset). Still CSRF-, size- and rate-checked. */
export function publicApi<P = Record<string, never>>(
  fn: (ctx: RequestContext<P>) => Promise<unknown>,
): RouteHandler<P> {
  return tag('public', (req, route) => run(req, route, fn));
}

/**
 * Every authenticated endpoint goes through this: the session is verified on the server and
 * the handler receives the actor. Permission checks happen inside the services.
 */
export function api<P = Record<string, never>>(
  fn: (ctx: AuthedContext<P>) => Promise<unknown>,
): RouteHandler<P> {
  return tag('authenticated', (req, route) =>
    run(req, route, async (ctx) => {
      const actor = await authenticated(req);
      const authed = { ...ctx, actor };
      return req.method === 'POST' ? idempotent(req, authed, fn) : fn(authed);
    }),
  );
}

/**
 * ENGINEERING-STANDARDS §4: every authenticated POST carries an Idempotency-Key. A retry or a
 * double submit with the same key gets the first response instead of creating a second
 * receipt, invoice or user.
 */
async function idempotent<P>(
  req: NextRequest,
  ctx: AuthedContext<P>,
  fn: (ctx: AuthedContext<P>) => Promise<unknown>,
): Promise<unknown> {
  const key = req.headers.get('idempotency-key');
  if (!key)
    throw new DomainError('VALIDATION', 'Send an Idempotency-Key header with this request.');
  const idem = services().idempotency;
  const start = await idem.begin(ctx.actor, key, req.method, req.nextUrl.pathname, ctx.body);
  if (start.kind === 'replay') {
    return start.status === 204
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(start.body, { status: start.status });
  }
  try {
    const result = await fn(ctx);
    if (result instanceof Response) await idem.finish(ctx.actor, key, result.status, null);
    else await idem.finish(ctx.actor, key, result === undefined ? 204 : 200, result);
    return result;
  } catch (error) {
    const status = error instanceof DomainError ? error.status : 500;
    await idem.finish(
      ctx.actor,
      key,
      status,
      error instanceof DomainError ? { error: error.toJSON() } : null,
    );
    throw error;
  }
}

/** Largest file upload (bill photos, Tech Spec §6): 10 MB plus a little multipart-free slack. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 + 1;

/**
 * An authenticated file upload: the raw request body (not JSON) up to MAX_UPLOAD_BYTES, with the
 * same session, origin and rate checks as api(). The service sniffs and cleans the bytes.
 */
export function apiUpload(
  fn: (ctx: AuthedContext<Record<string, never>> & { file: Buffer }) => Promise<unknown>,
): RouteHandler<Record<string, never>> {
  return tag('authenticated', (req, route) =>
    run(
      req,
      route,
      async (ctx) => {
        const actor = await authenticated(req);
        limits.upload.take(actor.userId);
        const declared = Number(req.headers.get('content-length') ?? '0');
        if (declared > MAX_UPLOAD_BYTES)
          throw new DomainError('TOO_LARGE', 'The file is larger than 10 MB.');
        const file = await readCapped(req.body, MAX_UPLOAD_BYTES);
        return fn({ ...ctx, actor, file });
      },
      'raw',
    ),
  );
}

/** The session's actor (verified on the server), rate-limited per user. */
async function authenticated(req: NextRequest): Promise<Actor> {
  const token = req.cookies.get(COOKIE.access)?.value ?? bearer(req);
  if (!token) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
  // The notification poll marks itself: it must not count as activity (BUG-163).
  const background = req.headers.get('x-csd-background') === '1';
  const { actor } = await services().auth.authenticate(token, { background });
  limits.api.take(actor.userId);
  return actor;
}

/** Health probes: no session, no body, no data beyond up/down. */
export function probe(fn: () => Promise<Response>): RouteHandler<Record<string, never>> {
  return tag('probe', () => fn());
}

async function run<P>(
  req: NextRequest,
  route: { params: Promise<P> },
  fn: (ctx: RequestContext<P>) => Promise<unknown>,
  bodyKind: 'json' | 'raw' = 'json',
): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (MUTATING.has(req.method)) assertSameOrigin(req);
    const body = MUTATING.has(req.method) && bodyKind === 'json' ? await readJson(req) : undefined;
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

/** CSRF defence in depth (on top of SameSite cookies): mutations must be same-origin. */
function assertSameOrigin(req: NextRequest): void {
  const expected = new URL(env().APP_URL).origin;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (origin ? origin === expected : site === 'same-origin') return;
  throw new DomainError('FORBIDDEN', 'Cross-site request refused.');
}

/**
 * Reads at most MAX_BODY_BYTES: a declared Content-Length over the cap is refused before
 * reading, and the stream is cut off as soon as it passes the cap, so memory stays bounded.
 */
export async function readJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new DomainError('TOO_LARGE', 'Request is too large.');
  const bytes = await readCapped(req.body);
  const size = bytes.byteLength;
  if (size === 0) return {};
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    throw new DomainError('VALIDATION', 'Send JSON.');
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new DomainError('VALIDATION', 'Request body is not valid JSON.');
  }
}

/** Reads a body stream, stopping (and cancelling it) as soon as it passes MAX_BODY_BYTES. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max = MAX_BODY_BYTES,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new DomainError('TOO_LARGE', 'Request is too large.');
    }
    chunks.push(value);
  }
}

function bearer(req: NextRequest): string | undefined {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/** "203.0.113.7:51234", "[2001:db8::1]:443" or a bare address → the address, if it is one. */
export function parseIp(raw: string): string | null {
  let s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed?.[1]) s = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  return isIP(s) ? s : null;
}

/** Client IP = the address added by our nearest trusted proxy, not a client-supplied one. */
export function trustedIp(forwardedFor: string | null, trusted: number): string | null {
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (trusted === 0 || hops.length < trusted) return null;
  return parseIp(hops[hops.length - trusted] ?? '');
}

/**
 * The per-IP rate-limit key. An IPv6 client usually controls a whole /64, so IPv6 addresses are
 * keyed by that prefix (BUG-185); IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function ipKey(ip: string | null): string {
  if (!ip) return 'ip:unknown';
  if (isIP(ip) !== 6) return `ip:${ip}`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return `ip:${mapped[1]}`;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `ip6:${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export function clientInfo(req: NextRequest): ClientInfo {
  return {
    ip: trustedIp(req.headers.get('x-forwarded-for'), env().TRUSTED_PROXIES),
    userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
    deviceId: req.cookies.get(COOKIE.device)?.value ?? null,
  };
}

/**
 * The device id must exist BEFORE the session is created, so the session records it and the
 * browser's next sign-in is recognised. Returns the client info to use and whether it is new.
 */
export function withDevice(client: ClientInfo): { client: ClientInfo; newDevice: string | null } {
  if (client.deviceId && /^[0-9a-f-]{36}$/i.test(client.deviceId))
    return { client, newDevice: null };
  const deviceId = randomUUID();
  return { client: { ...client, deviceId }, newDevice: deviceId };
}

const secure = (): boolean => new URL(env().APP_URL).protocol === 'https:';

/**
 * Session cookies, all httpOnly and Secure on https. The access and device cookies are
 * SameSite=Lax so a link opened from email or WhatsApp keeps the user signed in (mutations are
 * still origin-checked). The refresh cookie stays Strict and is scoped to /api/v1/auth.
 */
export function withSessionCookies(
  res: NextResponse,
  tokens: Tokens,
  newDevice: string | null,
): NextResponse {
  const base = { httpOnly: true, secure: secure() };
  res.cookies.set(COOKIE.access, tokens.accessToken, {
    ...base,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60,
  });
  res.cookies.set(COOKIE.refresh, tokens.refreshToken, {
    ...base,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: tokens.refreshExpiresAt,
  });
  if (newDevice)
    res.cookies.set(COOKIE.device, newDevice, {
      ...base,
      sameSite: 'lax',
      path: '/',
      maxAge: 400 * 24 * 3600,
    });
  return res;
}

export function clearSessionCookies(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE.access, '', { path: '/', maxAge: 0 });
  res.cookies.set(COOKIE.refresh, '', { path: '/api/v1/auth', maxAge: 0 });
  return res;
}
