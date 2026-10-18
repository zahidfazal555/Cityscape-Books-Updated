import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService, ContactsService } from '../src/index.js';
import {
  actorFor,
  appPool,
  closePools,
  makeCompany,
  makeUser,
  superPool,
  type Fixture,
} from './helpers.js';

const audit = new AuditService(appPool);
let f: Fixture;

beforeAll(async () => {
  f = await makeCompany('Audit Co');
  const owner = actorFor(f, f.ownerId, 'owner');
  const contacts = new ContactsService(appPool);
  for (let i = 0; i < 3; i++)
    await contacts.create(owner, { type: 'vendor', name: `V${i}`, stateCode: '33' });
});
afterAll(closePools);

describe('audit trail viewer', () => {
  it('owner and auditor read newest first with keyset paging; others are refused', async () => {
    const owner = actorFor(f, f.ownerId, 'owner');
    const page1 = await audit.list(owner, { limit: 2, entity: 'contact' });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.id).toBeGreaterThan(page1[1]!.id);
    expect(page1[0]!.userName).toBe('Owner');
    const page2 = await audit.list(owner, { limit: 2, entity: 'contact', beforeId: page1[1]!.id });
    expect(page2).toHaveLength(1);
    const auditor = actorFor(f, await makeUser(f.companyId, 'auditor'), 'auditor');
    await expect(audit.list(auditor)).resolves.toBeDefined();
    const admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
    await expect(audit.list(admin)).rejects.toMatchObject({ status: 403 });
  });
});

describe('fifth review regressions (audit, settings, me)', () => {
  it('BUG-047: a project-scoped auditor only sees audit entries for their projects, without profit fields', async () => {
    const { ProjectsService } = await import('../src/index.js');
    const owner = actorFor(f, f.ownerId, 'owner');
    await superPool.query(
      `INSERT INTO number_series VALUES ($1, 'project', '-', 2) ON CONFLICT DO NOTHING`,
      [f.companyId],
    );
    const secret = await new ProjectsService(appPool).create(owner, {
      name: 'Secret Villa',
      clientId: f.clientId,
      startDate: '2026-10-01',
      contractValue: 5_00_00_000_00,
      costBudget: 3_00_00_000_00,
    });
    const scoped = actorFor(f, await makeUser(f.companyId, 'auditor'), 'auditor', [f.projectId]);
    const rows = await audit.list(scoped, { limit: 200 });
    expect(rows.every((r) => r.entity === 'project' && r.entityId === f.projectId)).toBe(true);
    expect(rows.some((r) => r.entityId === secret.id)).toBe(false);
    const ownerRows = await audit.list(owner, { entity: 'project' });
    expect(ownerRows.some((r) => r.entityId === secret.id)).toBe(true);
  });

  it('BUG-051: full settings are owner-only; company info and own profile are for every signed-in user', async () => {
    const { SettingsService, UsersService } = await import('../src/index.js');
    const settings = new SettingsService(appPool);
    const site = actorFor(f, await makeUser(f.companyId, 'site', 'Ravi'), 'site');
    await expect(settings.get(site)).rejects.toMatchObject({ status: 403 });
    await expect(settings.companyInfo(site)).resolves.toMatchObject({
      name: expect.any(String),
      fyStartMonth: 4,
    });
    const users = new UsersService(appPool, {} as never);
    await expect(users.me(site)).resolves.toMatchObject({ name: 'Ravi' });
    await expect(users.me({ ...site, active: false })).rejects.toMatchObject({ status: 401 });
  });
});
