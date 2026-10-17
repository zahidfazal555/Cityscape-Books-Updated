import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  TicketsService,
  anonymiseCallers,
  bootstrapCompany,
  slaSweep,
  verifyBooks,
} from '../src/index.js';
import { actorFor, appPool, closePools, makeCompany, superPool, type Fixture } from './helpers.js';
import { clientProject } from './sales-helpers.js';

const tickets = new TicketsService(appPool);
let f: Fixture;
let owner: Actor;
let projectId: string;

beforeAll(async () => {
  f = await makeCompany('Jobs Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  ({ projectId } = await clientProject(owner));
});

afterAll(closePools);

describe('scheduled jobs (go-live)', () => {
  it('the SLA sweep notifies without anyone opening the app', async () => {
    const t = await tickets.create(owner, {
      projectId,
      type: 'snag',
      subject: 'Night call',
      priority: 'urgent',
      channel: 'phone',
    });
    await superPool.query(
      `UPDATE ticket SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [t.id],
    );
    const r = await slaSweep({ app: appPool, admin: superPool });
    expect(r.companies).toBeGreaterThan(0);
    const { rows } = await superPool.query(
      `SELECT 1 FROM notification WHERE user_id = $1 AND key = $2`,
      [f.ownerId, `sla:${t.id}:resp:breach`],
    );
    expect(rows).toHaveLength(1);
  });

  it('anonymises callers on tickets closed more than 3 years ago, and only those', async () => {
    const make = async (subject: string) =>
      (
        await tickets.create(owner, {
          projectId,
          type: 'snag',
          subject,
          channel: 'phone',
          callerName: 'Mr X',
          callerPhone: '9840011111',
        })
      ).id;
    const old = await make('Old');
    const recent = await make('Recent');
    for (const id of [old, recent]) await tickets.update(owner, id, { status: 'closed' });
    await superPool.query(
      `UPDATE ticket SET closed_at = now() - interval '4 years' WHERE id = $1`,
      [old],
    );
    await anonymiseCallers({ app: appPool, admin: superPool });
    const caller = async (id: string) =>
      (await superPool.query(`SELECT caller_name, caller_phone FROM ticket WHERE id = $1`, [id]))
        .rows[0];
    expect(await caller(old)).toEqual({ caller_name: null, caller_phone: null });
    expect(await caller(recent)).toEqual({ caller_name: 'Mr X', caller_phone: '9840011111' });
  });

  it('verify:books passes for consistent books', async () => {
    const r = (await verifyBooks(superPool)).find((x) => x.companyId === f.companyId);
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('bootstrap creates the company, its accounts and a password-less Owner, once', async () => {
    const email = `owner.${Date.now()}@example.test`;
    const name = `Boot Co ${Date.now()}`;
    const r = await bootstrapCompany(superPool, {
      company: name,
      ownerName: 'Saravanan S',
      ownerEmail: email,
    });
    const { rows } = await superPool.query(
      `SELECT (SELECT count(*)::int FROM account WHERE company_id = $1) AS accounts,
              (SELECT password_hash FROM app_user WHERE id = $2) AS hash`,
      [r.companyId, r.ownerId],
    );
    expect(rows[0].accounts).toBeGreaterThan(10);
    expect(rows[0].hash).toBeNull();
    await expect(
      bootstrapCompany(superPool, { company: name, ownerName: 'X', ownerEmail: email }),
    ).rejects.toThrow();
  });
});
