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
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const send = (): Promise<Response> =>
    fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? null : JSON.stringify(init.body),
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

export { safeNext } from './redirect';
