import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HibpBreachChecker } from '../src/index.js';

const sha1 = (p: string) => createHash('sha1').update(p).digest('hex').toUpperCase();

describe('HIBP breach checker (k-anonymity)', () => {
  it('sends only the 5-char prefix, with padding, and matches the suffix', async () => {
    const hash = sha1('password123456');
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:0\n${hash.slice(5)}:2413945\nFFFF:1`),
    );
    const checker = new HibpBreachChecker(fetchFn as unknown as typeof fetch);
    await expect(checker.isBreached('password123456')).resolves.toBe(true);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(String(url)).not.toContain(hash.slice(5));
    expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
  });

  it('padding rows with count 0 are not breaches', async () => {
    const hash = sha1('Unique-pass-phrase-77');
    const checker = new HibpBreachChecker(
      (async () => new Response(`${hash.slice(5)}:0`)) as unknown as typeof fetch,
    );
    await expect(checker.isBreached('Unique-pass-phrase-77')).resolves.toBe(false);
  });

  it('fails open on outages and errors', async () => {
    const down = new HibpBreachChecker(
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    );
    const broken = new HibpBreachChecker((async () =>
      Promise.reject(new Error('dns'))) as unknown as typeof fetch);
    await expect(down.isBreached('x')).resolves.toBe(false);
    await expect(broken.isBreached('x')).resolves.toBe(false);
  });
});
