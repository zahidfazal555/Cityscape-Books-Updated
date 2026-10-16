const PROBE_ORIGIN = 'https://app.invalid';

/**
 * Only same-origin paths are allowed as post-sign-in targets (no open redirect). Control
 * characters and backslashes are refused outright, because URL parsers strip or rewrite them
 * (e.g. "/\t/evil.example" becomes "//evil.example").
 */
export function safeNext(next: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we must refuse
  if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, PROBE_ORIGIN);
  } catch {
    return '/';
  }
  return url.origin === PROBE_ORIGIN ? `${url.pathname}${url.search}${url.hash}` : '/';
}
