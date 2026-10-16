import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplate, type Actor } from '@csd/core';
import {
  OWNER_PASSWORD,
  client,
  closePools,
  emailOf,
  makeCompany,
  makeServices,
  setPassword,
  superPool,
  type Fixture,
} from './helpers.js';

const s = makeServices();
let f: Fixture;
let owner: Actor;

beforeAll(async () => {
  f = await makeCompany('Users Co');
  await setPassword(f.ownerId, OWNER_PASSWORD);
  const t = await s.auth.login(await emailOf(f.ownerId), OWNER_PASSWORD, client);
  owner = (await s.auth.authenticate(t.accessToken)).actor;
});
afterAll(closePools);

const base = { name: 'Accounts Admin', role: 'admin' as const, projectsAll: true };
let n = 0;
const email = () => `user${++n}@users.example.test`;

describe('owner-only admin panel', () => {
  it('nobody but the owner can list, create or edit users', async () => {
    const adminId = await s.users.create(owner, { ...base, email: email() });
    const admin: Actor = {
      userId: adminId,
      companyId: f.companyId,
      role: 'admin',
      rights: roleTemplate('admin'),
      projects: 'all',
      active: true,
    };
    await expect(s.users.list(admin)).rejects.toMatchObject({ status: 403 });
    await expect(s.users.create(admin, { ...base, email: email() })).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.settings.setLockDate(admin, '2026-09-30')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('creates a user with the role template, invites them and audits it', async () => {
    const e = email();
    const id = await s.users.create(owner, {
      ...base,
      role: 'manager',
      email: e,
      phone: '9876543210',
    });
    const row = (await s.users.list(owner)).find((u) => u.id === id)!;
    expect(row).toMatchObject({
      role: 'manager',
      rightsLabel: 'Role default',
      invitePending: true,
      phone: '9876543210',
    });
    expect(row.rights).toEqual(roleTemplate('manager'));
    expect(
      s.mailer.outbox.some((m) => m.to === e && m.text.includes('/accept-invite?token=')),
    ).toBe(true);
    const audit = await superPool.query(
      `SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'create'`,
      [id],
    );
    expect(audit.rows[0].after).toMatchObject({ email: e, role: 'manager' });
  });

  it('custom rights show the Custom badge; changing role resets to the new template', async () => {
    const id = await s.users.create(owner, { ...base, role: 'manager', email: email() });
    await s.users.update(owner, id, {
      permissions: { ...roleTemplate('manager'), banking: 'view' },
    });
    let row = (await s.users.list(owner)).find((u) => u.id === id)!;
    expect(row.rightsLabel).toBe('Custom rights');
    expect(row.rights.banking).toBe('view');
    await s.users.update(owner, id, { role: 'site' });
    row = (await s.users.list(owner)).find((u) => u.id === id)!;
    expect(row.rights).toEqual(roleTemplate('site'));
    expect(row.rightsLabel).toBe('Role default');
  });

  it('a rights change signs the user out (mover rule) and is audited with before/after', async () => {
    const id = await s.users.create(owner, { ...base, email: email() });
    await superPool.query(
      `INSERT INTO session (company_id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
      [f.companyId, id, `h-${id}`],
    );
    await s.users.update(owner, id, { permissions: { ...roleTemplate('admin'), payroll: 'view' } });
    const live = await superPool.query(
      'SELECT 1 FROM session WHERE user_id = $1 AND revoked_at IS NULL',
      [id],
    );
    expect(live.rowCount).toBe(0);
    const audit = await superPool.query(
      `SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'update'`,
      [id],
    );
    expect(audit.rows[0].before.rights.payroll).toBe('full');
    expect(audit.rows[0].after.rights.payroll).toBe('view');
  });

  it('scoped users need at least one existing project', async () => {
    await expect(
      s.users.create(owner, { ...base, email: email(), projectsAll: false }),
    ).rejects.toThrow('at least one project');
    await expect(
      s.users.create(owner, {
        ...base,
        email: email(),
        projectsAll: false,
        projectIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).rejects.toThrow('does not exist');
    const id = await s.users.create(owner, {
      ...base,
      email: email(),
      role: 'site',
      projectsAll: false,
      projectIds: [f.projectId],
    });
    expect((await s.users.list(owner)).find((u) => u.id === id)?.projectIds).toEqual([f.projectId]);
  });

  it('validates name, email, mobile, duplicates and rights levels', async () => {
    await expect(
      s.users.create(owner, { ...base, name: ' ', email: email() }),
    ).rejects.toMatchObject({ field: 'name' });
    await expect(s.users.create(owner, { ...base, email: 'not-an-email' })).rejects.toMatchObject({
      field: 'email',
    });
    await expect(
      s.users.create(owner, { ...base, email: email(), phone: '12345' }),
    ).rejects.toMatchObject({ field: 'phone' });
    const e = email();
    await s.users.create(owner, { ...base, email: e });
    await expect(s.users.create(owner, { ...base, email: e.toUpperCase() })).rejects.toThrow(
      'already exists',
    );
    await expect(
      s.users.create(owner, {
        ...base,
        email: email(),
        permissions: { ...roleTemplate('admin'), approvals: 'view' },
      }),
    ).rejects.toMatchObject({ field: 'permissions.approvals' });
    await expect(
      s.users.create(owner, { ...base, email: email(), role: 'owner' as never }),
    ).rejects.toMatchObject({ field: 'role' });
  });

  it('auditors need an expiry and can never get write rights', async () => {
    await expect(
      s.users.create(owner, { ...base, email: email(), role: 'auditor' }),
    ).rejects.toThrow('access ends');
    await expect(
      s.users.create(owner, {
        ...base,
        email: email(),
        role: 'auditor',
        accessExpiresAt: new Date(Date.now() + 1e9),
        permissions: { ...roleTemplate('auditor'), invoices: 'edit' },
      }),
    ).rejects.toThrow('only have view access');
  });

  it('the owner row cannot be edited or deactivated', async () => {
    await expect(s.users.update(owner, f.ownerId, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.users.setActive(owner, f.ownerId, false)).rejects.toMatchObject({ status: 403 });
    expect((await s.users.list(owner))[0]).toMatchObject({
      id: f.ownerId,
      rightsLabel: 'Full access',
    });
  });
});

describe('lock date (FR-3.3.1)', () => {
  it('owner sets and clears the lock date; future dates are refused; changes are audited', async () => {
    await s.settings.setLockDate(owner, '2026-09-30');
    expect((await s.settings.get(owner)).lockDate).toBe('2026-09-30');
    await expect(s.settings.setLockDate(owner, '2999-01-01')).rejects.toThrow(
      'cannot be in the future',
    );
    await expect(s.settings.setLockDate(owner, '2026-02-30')).rejects.toMatchObject({
      field: 'lockDate',
    });
    await s.settings.setLockDate(owner, null);
    const { rows } = await superPool.query(
      `SELECT before, after FROM audit_log WHERE company_id = $1 AND action = 'lock_date_change' ORDER BY id`,
      [f.companyId],
    );
    expect(rows.map((r) => [r.before.lockDate, r.after.lockDate])).toEqual([
      [null, '2026-09-30'],
      ['2026-09-30', null],
    ]);
  });
});
