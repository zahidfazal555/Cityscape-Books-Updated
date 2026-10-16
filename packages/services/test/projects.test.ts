import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
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

const projects = new ProjectsService(appPool);
const contacts = new ContactsService(appPool);
let f: Fixture;
let owner: Actor;
let pm: Actor;
let pmId: string;

const input = (over: Record<string, unknown> = {}) => ({
  name: 'Anand Residence – 3BHK Interiors',
  clientId: f.clientId,
  siteAddress: 'Anna Nagar, Chennai',
  startDate: '2026-10-01',
  contractValue: 12_50_000_00,
  costBudget: 9_00_000_00,
  ...over,
});

beforeAll(async () => {
  f = await makeCompany('Projects Co');
  // The fixture's project already uses CSD-PRJ-0001.
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  pmId = await makeUser(f.companyId, 'manager', 'Shiva');
  pm = actorFor(f, pmId, 'manager');
});
afterAll(closePools);

describe('projects', () => {
  it('creates CSD-PRJ-#### with exact paise and the client’s state', async () => {
    const { id, code } = await projects.create(pm, input({ managerId: pmId }));
    expect(code).toBe('CSD-PRJ-0002');
    expect(await projects.get(pm, id)).toMatchObject({
      code,
      status: 'active',
      contractValue: 12_50_000_00,
      costBudget: 9_00_000_00,
      clientStateCode: '33',
      managerId: pmId,
    });
    expect((await projects.create(pm, input())).code).toBe('CSD-PRJ-0003');
  });

  it('validates client, team members, dates and amounts', async () => {
    const vendor = await contacts.create(owner, {
      type: 'vendor',
      name: 'Not A Client',
      stateCode: '33',
    });
    await expect(projects.create(pm, input({ clientId: vendor }))).rejects.toMatchObject({
      field: 'clientId',
    });
    await expect(
      projects.create(pm, input({ managerId: '00000000-0000-4000-8000-000000000000' })),
    ).rejects.toMatchObject({ field: 'managerId' });
    await expect(projects.create(pm, input({ endDate: '2026-09-01' }))).rejects.toMatchObject({
      field: 'endDate',
    });
    await expect(projects.create(pm, input({ contractValue: -1 }))).rejects.toMatchObject({
      field: 'contractValue',
    });
    await expect(projects.create(pm, input({ costBudget: 10.5 }))).rejects.toMatchObject({
      field: 'costBudget',
    });
    await expect(projects.create(pm, input({ startDate: '2026-02-30' }))).rejects.toMatchObject({
      field: 'startDate',
    });
  });

  it('UAT 8: a scoped user sees only their projects; others answer 404', async () => {
    const other = await projects.create(owner, input({ name: 'Vertex Labs Office' }));
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [f.projectId]);
    expect((await projects.list(site)).map((p) => p.id)).toEqual([f.projectId]);
    await expect(projects.get(site, other.id)).rejects.toMatchObject({ status: 404 });
    await expect(projects.update(site, other.id, { name: 'X' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(projects.update(site, f.projectId, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a scoped creator keeps access to the project they create', async () => {
    const scopedPmId = await makeUser(f.companyId, 'manager');
    const scopedPm = actorFor(f, scopedPmId, 'manager', [f.projectId]);
    const { id } = await projects.create(scopedPm, input({ name: 'Scoped PM project' }));
    const { rows } = await superPool.query(
      'SELECT 1 FROM user_project WHERE user_id = $1 AND project_id = $2',
      [scopedPmId, id],
    );
    expect(rows).toHaveLength(1);
  });

  it('status rules: invalid moves are refused; only full rights reopen a completed project', async () => {
    const { id } = await projects.create(pm, input({ name: 'Status test' }));
    await projects.update(pm, id, { status: 'on_hold' });
    await projects.update(pm, id, { status: 'completed' });
    await expect(projects.update(pm, id, { status: 'on_hold' })).rejects.toMatchObject({
      field: 'status',
    });
    await expect(projects.update(pm, id, { status: 'active' })).rejects.toMatchObject({
      status: 403,
    });
    await projects.update(owner, id, { status: 'active' });
    expect((await projects.get(owner, id)).status).toBe('active');
    expect((await projects.list(owner, 'completed')).map((p) => p.id)).not.toContain(id);
  });

  it('edits are audited with before/after; the auditor can view but not edit', async () => {
    const { id } = await projects.create(pm, input({ name: 'Audit me' }));
    await projects.update(pm, id, { costBudget: 9_50_000_00 });
    const { rows } = await superPool.query(
      `SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'update'`,
      [id],
    );
    expect([rows[0].before.costBudget, rows[0].after.costBudget]).toEqual([
      9_00_000_00, 9_50_000_00,
    ]);
    const auditor = actorFor(f, await makeUser(f.companyId, 'auditor'), 'auditor');
    await expect(projects.get(auditor, id)).resolves.toBeDefined();
    await expect(projects.update(auditor, id, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(projects.create(auditor, input())).rejects.toMatchObject({ status: 403 });
  });

  it('another company’s project is invisible even with its id', async () => {
    const g = await makeCompany('Other Co');
    const otherOwner = actorFor(g, g.ownerId, 'owner');
    await expect(projects.get(otherOwner, f.projectId)).rejects.toMatchObject({ status: 404 });
    expect((await projects.list(otherOwner)).map((p) => p.id)).toEqual([g.projectId]);
  });
});
