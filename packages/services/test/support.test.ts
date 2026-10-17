import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  AttachmentsService,
  ExpensesService,
  InvoicesService,
  KnowledgeBaseService,
  NotificationsService,
  QuotationsService,
  MemoryBlobStore,
  SupportDashboardService,
  TicketBillingService,
  TicketsService,
  VisitsService,
  WarrantyService,
} from '../src/index.js';
import {
  actorFor,
  appPool,
  closePools,
  makeCompany,
  makeUser,
  superPool,
  type Fixture,
} from './helpers.js';
import { clientProject, invoiceInput, setLock } from './sales-helpers.js';

const tickets = new TicketsService(appPool);
const visits = new VisitsService(appPool);
const warranty = new WarrantyService(appPool);
const kb = new KnowledgeBaseService(appPool);
const billing = new TicketBillingService(appPool);
const dashboard = new SupportDashboardService(appPool);
const expenses = new ExpensesService(appPool);
const invoices = new InvoicesService(appPool);
const attachments = new AttachmentsService(appPool, new MemoryBlobStore());

// A real 8×8 JPEG (uploads are sniffed and re-encoded).
const JPEG = Buffer.from(
  jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data,
);

let f: Fixture;
let owner: Actor;
let asst: Actor;
let manager: Actor;
let site: Actor;
let projectId: string;
let handedOver: string;

beforeAll(async () => {
  f = await makeCompany('Support Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  asst = actorFor(f, await makeUser(f.companyId, 'asstmgr', 'Asst Manager'), 'asstmgr');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
  site = actorFor(f, await makeUser(f.companyId, 'site', 'Ravi Engineer'), 'site', []);
  ({ projectId } = await clientProject(owner));
  ({ projectId: handedOver } = await clientProject(owner));
});

afterAll(closePools);

const photo = async (who: Actor) => (await attachments.upload(who, JPEG)).id;

describe('warranty register (FR-20)', () => {
  it('records a handover, completes the project and validates the dates', async () => {
    await expect(
      warranty.recordHandover(owner, handedOver, {
        handoverDate: '2099-01-01',
        warrantyMonths: 12,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      warranty.recordHandover(owner, handedOver, {
        handoverDate: '2026-01-01',
        warrantyMonths: 12,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await warranty.recordHandover(owner, handedOver, {
      handoverDate: '2026-04-01',
      warrantyMonths: 6,
      amcUntil: '2027-03-31',
    });
    const row = (await warranty.register(owner)).find((r) => r.projectId === handedOver)!;
    expect(row).toMatchObject({
      status: 'expired',
      warrantyEnd: '2026-09-30',
      amcUntil: '2027-03-31',
    });
    const { rows } = await superPool.query(`SELECT status FROM project WHERE id = $1`, [
      handedOver,
    ]);
    expect(rows[0].status).toBe('completed');
    await expect(
      warranty.recordHandover(manager, handedOver, {
        handoverDate: '2026-04-01',
        warrantyMonths: 12,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('tickets (FR-19)', () => {
  let tk: string;

  it('logs a ticket with coverage decided now: chargeable after the warranty, contract before handover', async () => {
    const a = await tickets.create(asst, {
      projectId: handedOver,
      type: 'snag',
      subject: 'Laminate peeling',
      priority: 'high',
      channel: 'phone',
      callerName: 'Mr Rao',
      callerPhone: '9840012345',
      assigneeId: asst.userId,
    });
    expect(a.number).toMatch(/^TKT-\d{4}$/);
    tk = a.id;
    const t = await tickets.get(owner, tk);
    expect(t).toMatchObject({ coverage: 'chargeable', chargeable: true, status: 'open' });
    expect(new Date(t.respDue).getTime() - new Date(t.createdAt).getTime()).toBe(4 * 3_600_000);
    expect(t.events[0]?.body).toContain('chargeable');
    const amc = await tickets.create(asst, {
      projectId: handedOver,
      type: 'amc',
      subject: 'AMC check',
      channel: 'walk_in',
    });
    expect((await tickets.get(owner, amc.id)).coverage).toBe('amc');
    const pre = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Door alignment',
      channel: 'whatsapp',
    });
    expect((await tickets.get(owner, pre.id)).coverage).toBe('contract');
    await expect(
      tickets.create(manager, { projectId, type: 'snag', subject: 'x', channel: 'phone' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an internal note does not stamp the first response; a reply does', async () => {
    await tickets.addEvent(asst, tk, { kind: 'note', body: 'Checking stock of laminate' });
    expect((await tickets.get(owner, tk)).firstResponseAt).toBeNull();
    await tickets.addEvent(asst, tk, { kind: 'reply', body: 'We will visit tomorrow.' });
    expect((await tickets.get(owner, tk)).firstResponseAt).not.toBeNull();
  });

  it('a High ticket with no reply past 4 hours is breached, sorts first and notifies the assignee', async () => {
    const late = await tickets.create(asst, {
      projectId,
      type: 'snag',
      subject: 'Late one',
      priority: 'high',
      channel: 'phone',
      assigneeId: asst.userId,
    });
    await superPool.query(
      `UPDATE ticket SET created_at = now() - interval '5 hours' WHERE id = $1`,
      [late.id],
    );
    const queue = await tickets.list(asst, 'open');
    expect(queue[0]).toMatchObject({ id: late.id, breached: true });
    expect((await tickets.list(asst, 'breached')).map((t) => t.id)).toContain(late.id);
    const { rows } = await superPool.query(
      `SELECT title FROM notification WHERE user_id = $1 AND key = $2`,
      [asst.userId, `sla:${late.id}:resp:breach`],
    );
    expect(rows[0]?.title).toContain('overdue');
    const counts = await tickets.counts(asst);
    expect(counts.breached).toBeGreaterThanOrEqual(1);
  });

  it('scheduling a visit blocks resolving; only a site engineer can be scheduled', async () => {
    await expect(
      visits.schedule(asst, tk, {
        visitDate: '2099-12-31',
        slot: 'morning',
        engineerId: manager.userId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await visits.schedule(asst, tk, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: site.userId,
      instructions: 'Carry laminate edge band',
    });
    expect((await tickets.get(owner, tk)).status).toBe('visit_scheduled');
    await expect(tickets.update(asst, tk, { status: 'resolved' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const other = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Tap',
      channel: 'phone',
    });
    await expect(
      tickets.update(asst, other.id, { status: 'visit_scheduled' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('the engineer sees only their visit and completes it with photos; the cost waits as a Pending expense', async () => {
    const [v] = await visits.mine(site);
    expect(v?.ticketId).toBe(tk);
    await expect(
      visits.complete(site, v!.id, {
        beforeIds: [await photo(site)],
        afterIds: [],
        workDone: 'Re-pressed laminate',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      visits.complete(site, v!.id, {
        beforeIds: [await photo(site)],
        afterIds: [await photo(site)],
        workDone: 'Re-pressed laminate',
        cost: 1_200_00,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const before = await photo(site);
    const after = await photo(site);
    const bill = await photo(site);
    const r = await visits.complete(site, v!.id, {
      beforeIds: [before],
      afterIds: [after],
      workDone: 'Re-pressed laminate edge',
      cost: 1_200_00,
      category: 'material',
      mode: 'cash',
      billPhotoId: bill,
    });
    expect(r.expenseId).toBeTruthy();
    const t = await tickets.get(owner, tk);
    expect(t.status).toBe('in_progress');
    expect(t.events.some((e) => e.kind === 'note' && e.body.includes('Re-pressed'))).toBe(true);
    const pending = await expenses.pending(owner);
    expect(pending.find((e) => e.id === r.expenseId)).toMatchObject({
      amount: 1_200_00,
      status: 'pending',
    });
    // The photos follow the ticket: a ticket handler can view them; another site user cannot.
    await expect(attachments.read(asst, before)).resolves.toBeTruthy();
    const other = actorFor(f, await makeUser(f.companyId, 'site'), 'site', []);
    await expect(attachments.read(other, before)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A completed visit cannot be completed again.
    await expect(
      visits.complete(site, v!.id, {
        beforeIds: [await photo(site)],
        afterIds: [await photo(site)],
        workDone: 'x',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('resolving, rating, reopening (which clears both) and closing', async () => {
    await expect(tickets.rate(asst, tk, { rating: 5 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await tickets.update(asst, tk, { status: 'resolved' });
    await tickets.rate(asst, tk, { rating: 4, comment: 'Quick fix' });
    expect((await tickets.get(owner, tk)).rating).toBe(4);
    await tickets.update(asst, tk, { status: 'open' });
    const t = await tickets.get(owner, tk);
    expect(t).toMatchObject({ rating: null, resolvedAt: null, status: 'open' });
    await tickets.update(asst, tk, { status: 'closed' });
    expect((await tickets.get(owner, tk)).closedAt).not.toBeNull();
  });

  it('a site engineer with no project scope cannot read the ticket queue', async () => {
    await expect(tickets.list(site)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cancelling the only scheduled visit puts the ticket back in progress', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Hinge',
      channel: 'phone',
    });
    const { id } = await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'evening',
      engineerId: site.userId,
    });
    await visits.cancel(asst, id);
    expect((await tickets.get(owner, t.id)).status).toBe('in_progress');
  });

  it('links a quotation for the client and an invoice on the project; lists the visit cost', async () => {
    const inv = await invoices.create(
      owner,
      invoiceInput(handedOver, { invoiceDate: '2026-10-15' }),
    );
    {
      await billing.link(owner, tk, { kind: 'invoice', id: inv.id });
      await expect(billing.link(owner, tk, { kind: 'invoice', id: inv.id })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
    const b = await billing.get(owner, tk);
    expect(b.costs[0]).toMatchObject({ amount: 1_200_00, status: 'pending' });
    expect(b.documents.map((d) => d.number)).toContain(inv.number);
  });

  it('the dashboard counts response SLA and service cost', async () => {
    const d = await dashboard.get(owner);
    expect(d.serviceCost?.pending).toBe(1_200_00);
    expect(d.byType.find((x) => x.key === 'snag')?.count).toBeGreaterThanOrEqual(2);
    expect(d.responseSlaMetPct).not.toBeNull();
    expect(d.workload.find((w) => w.name === 'Asst Manager')).toBeTruthy();
  });
});

describe('knowledge base (FR-21)', () => {
  it('kb edit creates and edits; kb full deletes; view can read', async () => {
    const { id } = await kb.saveTemplate(asst, null, {
      title: 'Visit confirmation',
      body: 'Dear {client}, ticket {ticket}: {engineer} visits on {date}.',
    });
    await kb.saveTemplate(asst, id, { title: 'Visit confirmed', body: 'Hi {client}' });
    expect((await kb.templates(manager)).map((t) => t.title)).toContain('Visit confirmed');
    await expect(kb.saveTemplate(manager, null, { title: 'x', body: 'y' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const a = await kb.saveArticle(asst, null, {
      title: 'Laminate care',
      category: 'care',
      body: 'Wipe dry.',
    });
    await kb.remove(asst, 'article', a.id);
    expect(await kb.articles(owner)).toEqual([]);
  });
});

describe('locks and scope', () => {
  it('a visit cost cannot be booked into a locked month', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Locked',
      channel: 'phone',
    });
    const { id } = await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: site.userId,
    });
    await setLock(f.companyId, '2099-12-31');
    try {
      await expect(
        visits.complete(site, id, {
          beforeIds: [await photo(site)],
          afterIds: [await photo(site)],
          workDone: 'Fixed',
          cost: 100_00,
          billPhotoId: await photo(site),
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    } finally {
      await setLock(f.companyId, null);
    }
  });
});

describe('review regressions (PR 16)', () => {
  const completeWithCost = async (visitId: string) =>
    visits.complete(site, visitId, {
      beforeIds: [await photo(site)],
      afterIds: [await photo(site)],
      workDone: 'Fixed hinge',
      cost: 500_00,
      billPhotoId: await photo(site),
    });

  it('BUG-154: a visit cost on a handed-over (Completed) project can be approved', async () => {
    const t = await tickets.create(asst, {
      projectId: handedOver,
      type: 'warranty',
      subject: 'Hinge',
      channel: 'phone',
    });
    const { id } = await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: site.userId,
    });
    const { expenseId } = await completeWithCost(id);
    await expenses.approve(owner, expenseId!);
    expect((await expenses.get(owner, expenseId!)).status).toBe('approved');
  });

  it('BUG-155/156: a ticket quotation accepts onto the ticket project, even after handover, and no other', async () => {
    const { rows } = await superPool.query<{ client_id: string }>(
      `SELECT client_id FROM project WHERE id = $1`,
      [handedOver],
    );
    const clientId = rows[0]!.client_id;
    const quotes = new QuotationsService(appPool);
    const mk = async () => {
      const q = await quotes.create(owner, {
        clientId,
        title: 'Service: re-laminate',
        quoteDate: '2026-10-15',
        validTill: '2026-11-15',
        lines: [
          { description: 'Labour', qtyMilli: 1000, unit: 'lot', rate: 5_000_00, gstRate: 18 },
        ],
      });
      const t = await tickets.create(asst, {
        projectId: handedOver,
        type: 'snag',
        subject: 'Quote',
        channel: 'phone',
      });
      await billing.link(owner, t.id, { kind: 'quotation', id: q.id });
      await quotes.send(owner, q.id);
      return q.id;
    };
    const a = await mk();
    expect((await quotes.accept(owner, a)).projectId).toBe(handedOver);
    const b = await mk();
    await expect(quotes.accept(owner, b, { projectId })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('BUG-157: a scheduled visit cannot be left by hand; completing it moves the ticket to In progress', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Machine',
      channel: 'phone',
    });
    const { id } = await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: site.userId,
    });
    await expect(tickets.update(asst, t.id, { status: 'awaiting_client' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await visits.complete(site, id, {
      beforeIds: [await photo(site)],
      afterIds: [await photo(site)],
      workDone: 'Done',
    });
    expect((await tickets.get(owner, t.id)).status).toBe('in_progress');
  });

  it('BUG-158: caller details are not copied into the audit log', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'snag',
      subject: 'Private',
      channel: 'phone',
      callerName: 'Mrs Lakshmi',
      callerPhone: '9840099999',
    });
    const { rows } = await superPool.query<{ after: string }>(
      `SELECT after::text FROM audit_log WHERE entity = 'ticket' AND entity_id = $1`,
      [t.id],
    );
    expect(rows[0]?.after).not.toContain('9840099999');
    expect(rows[0]?.after).not.toContain('Lakshmi');
  });

  it('BUG-159: two handlers with the same name get their own workload rows', async () => {
    const twinA = actorFor(f, await makeUser(f.companyId, 'asstmgr', 'Twin'), 'asstmgr');
    const twinB = actorFor(f, await makeUser(f.companyId, 'asstmgr', 'Twin'), 'asstmgr');
    for (const tw of [twinA, twinB])
      await tickets.create(tw, {
        projectId,
        type: 'snag',
        subject: 'Twin',
        channel: 'phone',
        assigneeId: tw.userId,
      });
    const d = await dashboard.get(owner);
    expect(d.workload.filter((w) => w.name === 'Twin')).toHaveLength(2);
  });

  it('BUG-160: both clocks notify, and reading notifications sweeps them', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'snag',
      subject: 'Both late',
      priority: 'urgent',
      channel: 'phone',
      assigneeId: asst.userId,
    });
    await superPool.query(
      `UPDATE ticket SET created_at = now() - interval '5 hours' WHERE id = $1`,
      [t.id],
    );
    const n = await new NotificationsService(appPool).mine(asst);
    const titles = n.items.filter((i) => i.link === `/tickets/${t.id}`).map((i) => i.body ?? '');
    expect(titles.some((b) => b.startsWith('No response'))).toBe(true);
    expect(titles.some((b) => b.startsWith('Not resolved'))).toBe(true);
    await new NotificationsService(appPool).markRead(asst);
    expect((await new NotificationsService(appPool).mine(asst)).unread).toBe(0);
  });

  it('BUG-161: a scoped handler sees visits on their projects, filtered before the limit', async () => {
    const scoped = actorFor(f, asst.userId, 'asstmgr', [projectId]);
    const list = await visits.list(scoped);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((v) => v.projectCode !== '')).toBe(true);
  });

  it('BUG-162: events written together keep their order', async () => {
    const t = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Order',
      channel: 'phone',
    });
    const { id } = await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: site.userId,
    });
    await visits.complete(site, id, {
      beforeIds: [await photo(site)],
      afterIds: [await photo(site)],
      workDone: 'Done',
    });
    const ev = (await tickets.get(owner, t.id)).events.map((e) => e.body);
    expect(ev.findIndex((b) => b.startsWith('Visit completed'))).toBeLessThan(
      ev.findIndex((b) => b.startsWith('Work done')),
    );
  });
});

describe('review regressions (PR 17)', () => {
  it('BUG-170: a site engineer with a scheduled visit can upload photos even without expenses edit', async () => {
    const eng = actorFor(f, await makeUser(f.companyId, 'site', 'Narrow'), 'site', []);
    const narrow = { ...eng, rights: { ...eng.rights, expenses: 'none' as const } };
    await expect(attachments.upload(narrow, JPEG)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const t = await tickets.create(asst, {
      projectId,
      type: 'service',
      subject: 'Narrow',
      channel: 'phone',
    });
    await visits.schedule(asst, t.id, {
      visitDate: '2099-12-31',
      slot: 'morning',
      engineerId: eng.userId,
    });
    await expect(attachments.upload(narrow, JPEG)).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
  });
});
