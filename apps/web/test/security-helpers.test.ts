import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rate-limit';
import { safeNext } from '../src/lib/redirect';
import { MAX_BODY_BYTES, parseIp, readJson, trustedIp } from '../src/lib/http';
import { redactForLog } from '../src/lib/log';

describe('safeNext (no open redirect)', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/projects?status=active#top')).toBe('/projects?status=active#top');
  });
  it.each([
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r//evil.example',
    'https://evil.example',
    'evil',
    '',
    null,
  ])('refuses %j', (bad) => expect(safeNext(bad)).toBe('/'));
});

describe('client IP from X-Forwarded-For', () => {
  it('strips ports and validates addresses', () => {
    expect(parseIp('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(parseIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(parseIp('2001:db8::1')).toBe('2001:db8::1');
    expect(parseIp('cafe')).toBeNull();
    expect(parseIp('999.1.1.1')).toBeNull();
  });
  it('uses the hop added by the nearest trusted proxy, never a spoofed first hop', () => {
    expect(trustedIp('6.6.6.6, 203.0.113.7:5000', 1)).toBe('203.0.113.7');
    expect(trustedIp('6.6.6.6', 0)).toBeNull();
    expect(trustedIp('', 1)).toBeNull();
  });
});

describe('request body cap', () => {
  const req = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://x.test', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
      duplex: 'half',
    } as RequestInit);

  it('refuses a declared oversize body without reading it', async () => {
    await expect(
      readJson(req('{}', { 'content-length': String(MAX_BODY_BYTES + 1) })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('cuts off a streamed body that passes the cap', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 16_384;
        c.enqueue(new Uint8Array(16_384));
        if (sent > 10 * MAX_BODY_BYTES) c.close();
      },
    });
    await expect(readJson(req(stream))).rejects.toMatchObject({ status: 413 });
    expect(sent).toBeLessThan(3 * MAX_BODY_BYTES);
  });
  it('parses normal JSON and rejects non-JSON', async () => {
    await expect(readJson(req('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(
      readJson(
        new Request('http://x.test', {
          method: 'POST',
          body: 'a=1',
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('rate limiter', () => {
  it('allows the limit per window, then answers 429, then resets', () => {
    let now = 0;
    const rl = new RateLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) rl.take('k');
    expect(() => rl.take('k')).toThrow(expect.objectContaining({ status: 429 }));
    rl.take('other');
    now = 1001;
    expect(() => rl.take('k')).not.toThrow();
  });
});

describe('log redaction', () => {
  it('redacts secrets at any depth and keeps company fields', () => {
    const out = JSON.stringify(
      redactForLog({
        companyId: 'c1',
        company: 'Cityscape',
        req: { body: { items: [{ meta: { a: { b: { c: { password: 'hunter2' } } } } }] } },
        refreshToken: 'x',
      }),
    );
    expect(out).not.toContain('hunter2');
    expect(out).toContain('"companyId":"c1"');
    expect(out).toContain('"company":"Cityscape"');
    expect(out).toContain('"refreshToken":"[redacted]"');
  });
});
