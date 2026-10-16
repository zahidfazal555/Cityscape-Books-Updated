import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplate, type Actor } from '@csd/core';
import {
  InvoicesService,
  ProformasService,
  ReceiptsService,
  SettingsService,
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
import { clientProject, invoiceInput } from './sales-helpers.js';

const settings = new SettingsService(appPool);
const invoices = new InvoicesService(appPool);
const proformas = new ProformasService(appPool);
const receipts = new ReceiptsService(appPool);
let f: Fixture;
let other: Fixture;
let owner: Actor;

beforeAll(async () => {
  f = await makeCompany('Screens Co');
  other = await makeCompany('Other Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  await superPool.query(
    `UPDATE company SET bank_acc = '001122334455', address = 'Chennai' WHERE id = $1`,
    [f.companyId],
  );
  owner = actorFor(f, f.ownerId, 'owner');
});
afterAll(closePools);

describe('sales screens (PR 8 review regressions)', () => {
  it('letterhead: any sales view reads it; no sales view is refused; never another company', async () => {
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site');
    await expect(settings.letterhead(site)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const base = roleTemplate('site');
    const receiptsOnly: Actor = { ...site, rights: { ...base, receipts: 'view' } };
    const lh = await settings.letterhead(receiptsOnly);
    expect(lh).toMatchObject({
      name: expect.stringContaining('Screens Co'),
      bankAccount: '001122334455',
      address: 'Chennai',
    });
    const otherOwner = actorFor(other, other.ownerId, 'owner');
    expect((await settings.letterhead(otherOwner)).name).toContain('Other Co');
  });

  it('invoice flags: editable and cancellable until a receipt; an applied advance keeps it cancellable', async () => {
    const { projectId } = await clientProject(owner);
    const { id } = await invoices.create(owner, invoiceInput(projectId));
    expect(await invoices.get(owner, id)).toMatchObject({ editable: true, cancellable: true });
    await receipts.record(owner, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 1_00,
      mode: 'cash',
    });
    expect(await invoices.get(owner, id)).toMatchObject({ editable: false, cancellable: false });

    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Advance',
      pfDate: '2026-10-01',
      dueDate: '2026-10-10',
      lines: [{ description: 'Advance', qtyMilli: 1000, rate: 1_000_00 }],
    });
    await receipts.record(owner, {
      proformaId: pf.id,
      receiptDate: '2026-10-02',
      amount: 500_00,
      mode: 'cash',
    });
    const conv = await proformas.convert(owner, pf.id, { invoiceDate: '2026-10-12' });
    expect(await invoices.get(owner, conv.invoiceId)).toMatchObject({
      appliedAdvances: 500_00,
      editable: false,
      cancellable: true,
    });
    // The register marks the applied advance so its Delete is not offered.
    const rows = await receipts.list(owner, { projectId });
    expect(rows.find((r) => r.proformaNumber)?.applied).toBe(true);
  });

  it('H4: an invoice CSV export writes an audit row with the filter and row count', async () => {
    const rows = await invoices.export(owner, { status: 'unpaid' });
    const { rows: audit } = await superPool.query<{ after: { rows: number; filter: unknown } }>(
      `SELECT after FROM audit_log WHERE company_id = $1 AND action = 'export' AND entity = 'invoice'
        ORDER BY id DESC LIMIT 1`,
      [f.companyId],
    );
    expect(audit[0]?.after).toMatchObject({ rows: rows.length, filter: { status: 'unpaid' } });
  });

  it('open-only pickers and mode totals cover every record, not one page', async () => {
    const open = await invoices.list(owner, { open: true });
    expect(open.every((i) => i.status !== 'cancelled' && i.balance > 0)).toBe(true);
    const pfs = await proformas.list(owner, { open: true });
    expect(pfs.every((p) => p.status !== 'converted' && p.balance > 0)).toBe(true);
    const totals = await receipts.totalsByMode(owner);
    const listed = (await receipts.list(owner)).filter((r) => r.mode === 'cash');
    expect(totals.cash).toBe(listed.reduce((s, r) => s + r.amount, 0));
  });
});
