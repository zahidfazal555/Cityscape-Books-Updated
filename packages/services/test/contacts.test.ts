import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gstinCheckChar, type Actor } from '@csd/core';
import { ContactsService } from '../src/index.js';
import {
  actorFor,
  appPool,
  closePools,
  makeCompany,
  makeUser,
  superPool,
  type Fixture,
} from './helpers.js';

const contacts = new ContactsService(appPool);
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
let f: Fixture;
let owner: Actor;
let pm: Actor;

beforeAll(async () => {
  f = await makeCompany('Contacts Co');
  owner = actorFor(f, f.ownerId, 'owner');
  pm = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
});
afterAll(closePools);

describe('clients & vendors (Req §4a)', () => {
  it('rights: PM edits, Asst. Manager views only, Site Engineer has no access', async () => {
    const asst = actorFor(f, await makeUser(f.companyId, 'asstmgr'), 'asstmgr');
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site');
    await expect(
      contacts.create(pm, { type: 'client', name: 'Anand Kumar', stateCode: '33' }),
    ).resolves.toBeTypeOf('string');
    await expect(contacts.list(asst, 'client')).resolves.toBeDefined();
    await expect(
      contacts.create(asst, { type: 'vendor', name: 'X', stateCode: '33' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(contacts.list(site, 'client')).rejects.toMatchObject({ status: 403 });
  });

  it('validates GSTIN check digit and that it matches the chosen state (FR-3.2.4)', async () => {
    const ka = gstin('29AAKFV7731M1Z');
    await expect(
      contacts.create(pm, { type: 'client', name: 'Vertex Labs', gstin: ka, stateCode: '33' }),
    ).rejects.toMatchObject({
      field: 'gstin',
      message: expect.stringContaining('starts with 29'),
    });
    await expect(
      contacts.create(pm, {
        type: 'client',
        name: 'Vertex Labs',
        gstin: '29AAKFV7731M1Z0',
        stateCode: '29',
      }),
    ).rejects.toMatchObject({ field: 'gstin' });
    const id = await contacts.create(pm, {
      type: 'client',
      name: 'Vertex Labs',
      gstin: ka.toLowerCase(),
      stateCode: '29',
    });
    expect(await contacts.get(pm, id)).toMatchObject({ gstin: ka, state: 'Karnataka' });
    await expect(
      contacts.create(pm, { type: 'client', name: 'Nowhere', stateCode: '99' }),
    ).rejects.toMatchObject({ field: 'stateCode' });
  });

  it('names are unique per type, case-insensitively; a client and vendor may share a name', async () => {
    await contacts.create(pm, { type: 'vendor', name: 'Sri Balaji Hardware', stateCode: '33' });
    await expect(
      contacts.create(pm, { type: 'vendor', name: 'sri balaji HARDWARE', stateCode: '33' }),
    ).rejects.toMatchObject({
      status: 422,
      field: 'name',
    });
    await expect(
      contacts.create(pm, { type: 'client', name: 'Sri Balaji Hardware', stateCode: '33' }),
    ).resolves.toBeTypeOf('string');
  });

  it('searches by name or GSTIN prefix and hides archived contacts', async () => {
    const id = await contacts.create(pm, {
      type: 'vendor',
      name: 'Chennai Plywood Depot',
      gstin: gstin('33AABCC1234D1Z'),
      stateCode: '33',
    });
    expect((await contacts.list(pm, 'vendor', 'plywood')).map((c) => c.id)).toContain(id);
    expect((await contacts.list(pm, 'vendor', '33AABCC')).map((c) => c.id)).toContain(id);
    await expect(contacts.archive(pm, id)).rejects.toMatchObject({ status: 403 });
    await contacts.archive(owner, id);
    expect((await contacts.list(pm, 'vendor', 'plywood')).map((c) => c.id)).not.toContain(id);
    await expect(contacts.get(pm, id)).rejects.toMatchObject({ status: 404 });
  });

  it('a client with an active project cannot be archived', async () => {
    await expect(contacts.archive(owner, f.clientId)).rejects.toMatchObject({ status: 409 });
  });

  it('updates are validated and audited with before/after', async () => {
    const id = await contacts.create(pm, {
      type: 'client',
      name: 'Dr. Meenakshi R',
      stateCode: '33',
      phone: '9840012345',
    });
    await expect(contacts.update(pm, id, { gstin: gstin('29AAKFV7731M1Z') })).rejects.toMatchObject(
      { field: 'gstin' },
    );
    await contacts.update(pm, id, { address: 'Kovilambakkam, Chennai', phone: null });
    const { rows } = await superPool.query(
      `SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'update'`,
      [id],
    );
    expect(rows[0].before.phone).toBe('9840012345');
    expect(rows[0].after).toMatchObject({ phone: null, address: 'Kovilambakkam, Chennai' });
    await expect(contacts.update(pm, 'nope', { name: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});
