import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplate, type Actor } from '@csd/core';
import { ContactsService, ProjectsService } from '../src/index.js';
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
const projects = new ProjectsService(appPool);
let f: Fixture;
let owner: Actor;
let pm: Actor;
let n = 0;

const projectInput = (clientId: string, name = `Project ${++n}`) => ({
  name,
  clientId,
  startDate: '2026-10-01',
  contractValue: 10_00_000_00,
  costBudget: 7_50_000_00,
});
const newClient = (extra: Record<string, unknown> = {}) =>
  contacts.create(owner, { type: 'client', name: `Client ${++n}`, stateCode: '33', ...extra });

beforeAll(async () => {
  f = await makeCompany('Masters Regress');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  pm = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
});
afterAll(closePools);

describe('fourth review regressions (contacts & projects)', () => {
  it('BUG-032: concurrent edits to different fields both survive', async () => {
    const { id } = await projects.create(pm, projectInput(f.clientId));
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        projects.update(pm, id, { costBudget: 8_00_000_00 + i }),
        projects.update(pm, id, { siteAddress: `Site ${i}` }),
      ]);
      expect(await projects.get(pm, id)).toMatchObject({
        costBudget: 8_00_000_00 + i,
        siteAddress: `Site ${i}`,
      });
    }
    const c = await newClient();
    await Promise.all([
      contacts.update(pm, c, { address: 'A' }),
      contacts.update(pm, c, { phone: '9876543210' }),
    ]);
    expect(await contacts.get(pm, c)).toMatchObject({ address: 'A', phone: '9876543210' });
  });

  it('BUG-033: a closed project cannot be reopened under an archived client', async () => {
    const client = await newClient();
    const { id } = await projects.create(pm, projectInput(client));
    await projects.update(pm, id, { status: 'completed' });
    await contacts.archive(owner, client);
    await expect(projects.update(owner, id, { status: 'active' })).rejects.toMatchObject({
      field: 'clientId',
    });
  });

  it('BUG-034: archiving a client and creating a project for it never both succeed', async () => {
    for (let i = 0; i < 6; i++) {
      const client = await newClient();
      await Promise.allSettled([
        contacts.archive(owner, client),
        projects.create(pm, projectInput(client)),
      ]);
      const { rows } = await superPool.query(
        `SELECT 1 FROM project p JOIN contact c ON c.id = p.client_id
          WHERE c.id = $1 AND c.deleted_at IS NOT NULL AND p.status IN ('active', 'on_hold')`,
        [client],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('BUG-035: PANs are masked in lists and for users without payroll rights; full views are audited', async () => {
    const id = await contacts.create(owner, {
      type: 'vendor',
      name: `Vendor ${++n}`,
      stateCode: '33',
      pan: 'abcpe1234f',
    });
    const listed = (await contacts.list(pm, 'vendor')).find((c) => c.id === id);
    expect(listed?.pan).toBe('•••••1234F');
    expect((await contacts.get(pm, id)).pan).toBe('•••••1234F');
    expect((await contacts.get(owner, id)).pan).toBe('ABCPE1234F');
    const { rows } = await superPool.query(
      `SELECT user_id FROM audit_log WHERE entity_id = $1 AND action = 'view_pan'`,
      [id],
    );
    expect(rows).toEqual([{ user_id: f.ownerId }]);
    const created = await superPool.query(
      `SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'create'`,
      [id],
    );
    expect(created.rows[0].after.pan).toBe('•••••1234F');
  });

  it('BUG-036: blank optional form fields mean "not given" and can clear a value', async () => {
    const id = await newClient({ pan: '', phone: '', email: '' });
    expect(await contacts.get(owner, id)).toMatchObject({ pan: null, phone: null, email: null });
    await contacts.update(pm, id, { phone: '9876543210' });
    await contacts.update(pm, id, { phone: '' });
    expect((await contacts.get(pm, id)).phone).toBeNull();
  });

  it('BUG-037: a scoped creator’s new access is recorded in the audit trail', async () => {
    const userId = await makeUser(f.companyId, 'manager');
    const scoped = actorFor(f, userId, 'manager', [f.projectId]);
    const { id } = await projects.create(scoped, projectInput(f.clientId));
    const { rows } = await superPool.query(
      `SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'grant_scope'`,
      [userId],
    );
    expect(rows[0].after).toMatchObject({ projectId: id });
  });

  it('BUG-038: no projects right answers 403; out of scope answers 404', async () => {
    const noRights: Actor = {
      ...actorFor(f, await makeUser(f.companyId, 'admin'), 'admin'),
      rights: { ...roleTemplate('admin'), projects: 'none' },
    };
    await expect(projects.get(noRights, f.projectId)).rejects.toMatchObject({ status: 403 });
    await expect(projects.update(noRights, f.projectId, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
    const scoped = actorFor(f, await makeUser(f.companyId, 'site'), 'site', []);
    await expect(projects.get(scoped, f.projectId)).rejects.toMatchObject({ status: 404 });
  });

  it('BUG-039: % and _ in search text match literally', async () => {
    await contacts.create(owner, { type: 'vendor', name: '50%_Off Tiles', stateCode: '33' });
    await contacts.create(owner, { type: 'vendor', name: '50 Xoff Tiles', stateCode: '33' });
    expect((await contacts.list(pm, 'vendor', '50%_')).map((c) => c.name)).toEqual([
      '50%_Off Tiles',
    ]);
    expect((await contacts.list(pm, 'vendor', '%')).map((c) => c.name)).toEqual(['50%_Off Tiles']);
  });

  it('BUG-040: projects are indexed by client for the per-client counts', async () => {
    const { rows } = await superPool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'project'`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['project_client', 'project_created']),
    );
  });

  it('BUG-041: lists sort newest first by creation, not by code text', async () => {
    await superPool.query(
      `UPDATE number_series SET next_value = 9999 WHERE company_id = $1 AND series = 'project'`,
      [f.companyId],
    );
    const a = await projects.create(owner, projectInput(f.clientId));
    const b = await projects.create(owner, projectInput(f.clientId));
    expect([a.code, b.code]).toEqual(['CSD-PRJ-9999', 'CSD-PRJ-10000']);
    const codes = (await projects.list(owner)).map((p) => p.code);
    expect(codes.indexOf('CSD-PRJ-10000')).toBeLessThan(codes.indexOf('CSD-PRJ-9999'));
  });
});
