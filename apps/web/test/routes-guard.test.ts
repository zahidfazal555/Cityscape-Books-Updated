import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD } from '../src/lib/http';

const API_DIR = path.join(__dirname, '../src/app/api');
const PUBLIC_ALLOWED = new Set([
  'v1/auth/login',
  'v1/auth/refresh',
  'v1/auth/logout',
  'v1/auth/password/forgot',
  'v1/auth/password/reset',
  'v1/auth/invite/accept',
]);
const PROBES = new Set(['health']);
/** Next route-segment config exports that are not handlers. */
const CONFIG_EXPORTS = new Set([
  'dynamic',
  'revalidate',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'fetchCache',
]);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

/**
 * ENGINEERING-STANDARDS §2: no API handler can be exported without the auth wrapper. Each route
 * module is imported and EVERY export is checked, so `export function`, re-exports and any
 * HTTP method (HEAD, OPTIONS…) are covered.
 */
describe('API route guard', () => {
  const files = routes(API_DIR);

  it('finds the routes', () => expect(files.length).toBeGreaterThan(15));

  for (const file of files) {
    const rel = path.relative(API_DIR, path.dirname(file));
    it(`${rel}: every export is a guarded handler`, async () => {
      const mod = (await import(file)) as Record<string, unknown>;
      const handlers = Object.entries(mod).filter(([name]) => !CONFIG_EXPORTS.has(name));
      expect(handlers.length).toBeGreaterThan(0);
      for (const [name, value] of handlers) {
        const kind = (value as { [GUARD]?: string } | undefined)?.[GUARD];
        expect(
          kind,
          `${rel} export ${name} must be built with api(), publicApi() or probe()`,
        ).toBeDefined();
        if (kind === 'public')
          expect(PUBLIC_ALLOWED.has(rel), `${rel} may not be public`).toBe(true);
        if (kind === 'probe') expect(PROBES.has(rel), `${rel} may not be a probe`).toBe(true);
      }
    });
  }
});
