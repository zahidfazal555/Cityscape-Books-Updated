import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import { IdempotencyService } from '../src/index.js';
import { actorFor, appPool, closePools, makeCompany, superPool, type Fixture } from './helpers.js';

const idem = new IdempotencyService(appPool);
let f: Fixture;
let owner: Actor;
const key = (s: string) => `test-key-${s}-0123456789`;

beforeAll(async () => {
  f = await makeCompany('Idem Co');
  owner = actorFor(f, f.ownerId, 'owner');
});
afterAll(closePools);

describe('idempotency keys', () => {
  it('first run is fresh; a repeat replays the stored response', async () => {
    expect(await idem.begin(owner, key('a'), 'POST', '/api/v1/receipts', { amount: 1 })).toEqual({
      kind: 'fresh',
    });
    await expect(
      idem.begin(owner, key('a'), 'POST', '/api/v1/receipts', { amount: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await idem.finish(owner, key('a'), 200, { id: 'r1', number: 'RCT/26-27/0001' });
    expect(await idem.begin(owner, key('a'), 'POST', '/api/v1/receipts', { amount: 1 })).toEqual({
      kind: 'replay',
      status: 200,
      body: { id: 'r1', number: 'RCT/26-27/0001' },
    });
  });

  it('refuses a reused key with a different body, and malformed keys', async () => {
    await idem.begin(owner, key('b'), 'POST', '/x', { a: 1 });
    await expect(idem.begin(owner, key('b'), 'POST', '/x', { a: 2 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(idem.begin(owner, 'short', 'POST', '/x', {})).rejects.toMatchObject({
      status: 422,
    });
  });

  it('errors release the key (a corrected resubmission runs); keys expire after 24 hours', async () => {
    await idem.begin(owner, key('c'), 'POST', '/x', {});
    await idem.finish(owner, key('c'), 500, null);
    expect(await idem.begin(owner, key('c'), 'POST', '/x', {})).toEqual({ kind: 'fresh' });
    await idem.finish(owner, key('c'), 422, { error: { code: 'VALIDATION' } });
    expect(await idem.begin(owner, key('c'), 'POST', '/x', { corrected: true })).toEqual({ kind: 'fresh' });
    await idem.finish(owner, key('c'), 204, undefined);
    await superPool.query(
      `UPDATE idempotency_key SET created_at = now() - interval '25 hours' WHERE key = $1`,
      [key('c')],
    );
    expect(await idem.begin(owner, key('c'), 'POST', '/x', { changed: true })).toEqual({
      kind: 'fresh',
    });
  });
});
