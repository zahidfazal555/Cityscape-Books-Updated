import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_DIR = path.join(__dirname, '../src/app/api');
const PUBLIC_ALLOWED = new Set([
  'v1/auth/login',
  'v1/auth/refresh',
  'v1/auth/logout',
  'v1/auth/password/forgot',
  'v1/auth/password/reset',
  'v1/auth/invite/accept',
]);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

/**
 * ENGINEERING-STANDARDS §2: an API route cannot be exported without the auth wrapper.
 * Only the sign-in/reset endpoints may be public, and /api/health returns no data.
 */
describe('API route guard', () => {
  const files = routes(API_DIR);

  it('finds the routes', () => expect(files.length).toBeGreaterThan(15));

  for (const file of files) {
    const rel = path.relative(API_DIR, path.dirname(file));
    it(`${rel} wraps every handler`, () => {
      const src = readFileSync(file, 'utf8');
      const handlers = [
        ...src.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b(.*)/g),
      ];
      expect(handlers.length).toBeGreaterThan(0);
      for (const [, method, rest] of handlers) {
        if (rel === 'health') {
          expect(method).toBe('GET');
          continue;
        }
        const wrapper = /=\s*(api|publicApi)(<[^>]*>)?\(/.exec(rest ?? '')?.[1];
        expect(wrapper, `${rel} ${method} must use api() or publicApi()`).toBeDefined();
        if (wrapper === 'publicApi')
          expect(PUBLIC_ALLOWED.has(rel), `${rel} may not be public`).toBe(true);
      }
    });
  }
});
