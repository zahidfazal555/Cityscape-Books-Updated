import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDecimalString, roleTemplate, type Actor } from '@csd/core';
import { AccountantExportService, InvoicesService, ReceiptsService } from '../src/index.js';
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

const exporter = new AccountantExportService(appPool);
const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
let f: Fixture;
let owner: Actor;

beforeAll(async () => {
  f = await makeCompany('Accountant Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  const { projectId } = await clientProject(owner, '33', 'Pack Client');
  const inv = await invoices.create(owner, invoiceInput(projectId));
  await receipts.record(owner, {
    invoiceId: inv.id,
    receiptDate: '2026-10-11',
    amount: 1_00_000_00,
    mode: 'bank',
    reference: 'NEFT1',
  });
  // Outside the period below: must not appear in the period files.
  await invoices.create(owner, invoiceInput(projectId, { invoiceDate: '2026-09-15' }));
});
afterAll(closePools);

const file = (pack: { files: { name: string; rows: (string | number)[][] }[] }, name: string) =>
  pack.files.find((x) => x.name === name)?.rows ?? [];
const sum = (rows: (string | number)[][], col: number) =>
  rows.slice(1).reduce((n, r) => n + fromDecimalString(String(r[col])), 0);

describe('export for the accountant', () => {
  it('owner gets every book for the period as CSV rows; the day book and trial balance balance', async () => {
    const pack = await exporter.pack(owner, { from: '2026-10-01', to: '2026-10-31' });
    expect(pack.company).toMatch(/^Accountant Co/);
    expect(pack).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(pack.files.map((x) => x.name)).toEqual([
      'day-book',
      'trial-balance',
      'sales-invoices',
      'credit-notes',
      'client-receipts',
      'purchase-bills',
      'vendor-payments',
      'expenses',
      'payroll',
      'chart-of-accounts',
    ]);
    const sales = file(pack, 'sales-invoices');
    expect(sales[0]).toContain('Client GSTIN');
    expect(sales).toHaveLength(2);
    expect(sales[1]?.[1]).toBe('2026-10-10');
    expect(file(pack, 'client-receipts')[1]).toEqual(
      expect.arrayContaining(['Pack Client', 'bank', 'NEFT1', '100000.00']),
    );

    const day = file(pack, 'day-book');
    expect(day.length).toBeGreaterThan(1);
    expect(day.slice(1).every((r) => String(r[0]) >= '2026-10-01')).toBe(true);
    expect(sum(day, 8)).toBe(sum(day, 9));
    // The trial balance is the closing position on the last day: it includes September too.
    const tb = file(pack, 'trial-balance');
    expect(sum(tb, 3)).toBe(sum(tb, 4));
    expect(file(pack, 'chart-of-accounts').length).toBeGreaterThan(30);

    const { rows } = await superPool.query(
      `SELECT after FROM audit_log WHERE company_id = $1 AND entity = 'accountant_pack' ORDER BY id DESC LIMIT 1`,
      [f.companyId],
    );
    expect(rows[0].after).toMatchObject({
      format: 'csv-zip',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(rows[0].after.files['sales-invoices']).toBe(1);
  });

  it('defaults to this financial year to date; refuses a reversed range', async () => {
    const pack = await exporter.pack(owner, { to: '2026-10-31' });
    expect(pack.from).toBe('2026-04-01');
    expect(file(pack, 'sales-invoices')).toHaveLength(3);
    await expect(
      exporter.pack(owner, { from: '2026-11-01', to: '2026-10-01' }),
    ).rejects.toMatchObject({ field: 'from' });
  });

  it('only the owner and the auditor (CA) may export; each file needs its module right', async () => {
    const admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
    await expect(exporter.pack(admin)).rejects.toMatchObject({ status: 403 });
    const auditorId = await makeUser(f.companyId, 'auditor');
    const scoped = actorFor(f, auditorId, 'auditor', ['00000000-0000-4000-8000-000000000000']);
    await expect(exporter.pack(scoped)).rejects.toMatchObject({ status: 403 });

    const auditor = actorFor(f, auditorId, 'auditor');
    const pack = await exporter.pack(auditor, { from: '2026-10-01', to: '2026-10-31' });
    expect(pack.files.map((x) => x.name)).toContain('payroll');
    const noPayroll: Actor = {
      ...auditor,
      rights: { ...roleTemplate('auditor'), payroll: 'none', bills: 'none' },
    };
    const without = await exporter.pack(noPayroll, { from: '2026-10-01', to: '2026-10-31' });
    const names = without.files.map((x) => x.name);
    expect(names).not.toContain('payroll');
    expect(names).not.toContain('purchase-bills');
    expect(names).not.toContain('vendor-payments');
    expect(names).toContain('sales-invoices');
  });
});
