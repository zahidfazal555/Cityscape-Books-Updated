'use client';

export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
  }
}

let refreshing: Promise<boolean> | null = null;

/**
 * JSON content type when there is a body, and an Idempotency-Key on every POST: one key per
 * logical action, so the retry after a session refresh reuses it and the server never runs the
 * same POST twice. Forms pass a key that lives as long as the form is open.
 */
function requestHeaders(
  method: string,
  init: { body?: unknown; raw?: Blob; idempotencyKey?: string },
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init.raw) headers['content-type'] = init.raw.type || 'application/octet-stream';
  else if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['idempotency-key'] = init.idempotencyKey ?? newIdempotencyKey();
  return headers;
}

/** Unauthenticated endpoints: a 401 from these is an answer, not an expired session. */
const PUBLIC_AUTH = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/password/forgot',
  '/api/v1/auth/password/reset',
  '/api/v1/auth/invite/accept',
]);

/** One refresh at a time per tab; 409 means another tab already rotated the token. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok || r.status === 409)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * Same-origin JSON fetch. On 401 it refreshes the session once and retries; if that fails the
 * user is sent to sign-in, keeping the current page as `next`.
 */
export async function apiFetch<T>(
  path: string,
  /** `raw` sends a file as the request body (bill photo uploads). */
  init: { method?: string; body?: unknown; raw?: Blob; idempotencyKey?: string } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = requestHeaders(method, init);
  const send = (): Promise<Response> =>
    fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: init.raw ?? (init.body === undefined ? null : JSON.stringify(init.body)),
    });
  let res = await send();
  if (res.status === 401 && !PUBLIC_AUTH.has(path)) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) {
      window.location.assign(
        `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
      );
    }
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: ApiError };
  if (!res.ok) {
    throw new ApiFailure(
      res.status,
      data.error ?? { code: 'INTERNAL', message: 'Something went wrong.' },
    );
  }
  return data as T;
}

/**
 * A private file (bill photo) as a Blob, through the same refresh-on-401 as apiFetch: a plain
 * <img src> cannot refresh an expired session (BUG-111).
 */
export async function apiBlob(path: string): Promise<Blob> {
  const send = () => fetch(path, { credentials: 'same-origin' });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok)
    throw new ApiFailure(res.status, { code: 'INTERNAL', message: 'Could not load the file.' });
  return res.blob();
}

export { safeNext } from './redirect';

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
