import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rate-limit';
import { safeNext } from '../src/lib/redirect';
import { MAX_BODY_BYTES, ipKey, parseIp, readJson, trustedIp } from '../src/lib/http';
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

  it('BUG-185: rate limits key an IPv6 client by its /64, and IPv4-mapped as IPv4', () => {
    const a = ipKey('2001:db8:aa:bb:1:2:3:4');
    expect(a).toBe('ip6:2001:db8:aa:bb::/64');
    expect(ipKey('2001:0db8:00aa:00bb:ffff::9')).toBe(a);
    expect(ipKey('2001:db8:aa::1')).toBe('ip6:2001:db8:aa:0::/64');
    expect(ipKey('::1')).toBe('ip6:0:0:0:0::/64');
    expect(ipKey('::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
    expect(ipKey('203.0.113.7')).toBe('ip:203.0.113.7');
    expect(ipKey(null)).toBe('ip:unknown');
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

  it('BUG-186: drops the row values a Postgres error quotes', () => {
    const pgError = Object.assign(new Error('new row violates check constraint "contact_pan"'), {
      code: '23514',
      constraint: 'contact_pan',
      detail: 'Failing row contains (c1, Sri Murugan Traders, ABCDE1234F, 9876543210).',
      where: 'SQL statement "…"',
      parameters: ['ABCDE1234F'],
    });
    const out = JSON.stringify(redactForLog({ error: pgError }));
    expect(out).not.toContain('ABCDE1234F');
    expect(out).not.toContain('9876543210');
    expect(out).toContain('"code":"23514"');
    expect(out).toContain('"constraint":"contact_pan"');
  });
});

describe('configuration guards', () => {
  it('refuses a raised sign-in limit in production and bad values anywhere', async () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost/db',
      JWT_SECRET: Buffer.alloc(32, 1).toString('base64'),
      APP_URL: 'https://books.example',
    };
    const load = async (extra: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, base, extra);
      try {
        const { vi } = await import('vitest');
        vi.resetModules();
        const { env } = await import('../src/lib/env');
        return env();
      } finally {
        process.env = saved;
      }
    };
    await expect(
      load({
        NODE_ENV: 'production',
        MAIL_MODE: 'outbox',
        CSD_ALLOW_OUTBOX_IN_PRODUCTION: 'e2e',
        CSD_LOGIN_LIMIT_PER_MINUTE: '10',
        ATTACHMENT_DIR: '/var/lib/csd/attachments',
      }),
    ).resolves.toMatchObject({ CSD_LOGIN_LIMIT_PER_MINUTE: 10 });
    // Bill photos need a private directory in production.
    await expect(
      load({ NODE_ENV: 'production', MAIL_MODE: 'outbox', CSD_ALLOW_OUTBOX_IN_PRODUCTION: 'e2e' }),
    ).rejects.toThrow('ATTACHMENT_DIR');
    await expect(
      load({ NODE_ENV: 'development', CSD_LOGIN_LIMIT_PER_MINUTE: '-1' }),
    ).rejects.toThrow('CSD_LOGIN_LIMIT_PER_MINUTE');
    await expect(
      load({ NODE_ENV: 'development', CSD_LOGIN_LIMIT_PER_MINUTE: '5.5' }),
    ).rejects.toThrow('CSD_LOGIN_LIMIT_PER_MINUTE');
    await expect(
      load({ NODE_ENV: 'production', CSD_LOGIN_LIMIT_PER_MINUTE: '1000' }),
    ).rejects.toThrow();
    // BUG-185: production must sit behind a proxy that sets X-Forwarded-For.
    await expect(
      load({
        NODE_ENV: 'production',
        MAIL_MODE: 'smtp',
        SMTP_URL: 'smtps://u:p@mail.example:465',
        MAIL_FROM: 'books@example.in',
        ATTACHMENT_DIR: '/data/attachments',
        TRUSTED_PROXIES: '0',
      }),
    ).rejects.toThrow('TRUSTED_PROXIES');
  });
});
