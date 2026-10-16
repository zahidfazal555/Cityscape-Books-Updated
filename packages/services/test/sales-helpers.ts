import { gstinCheckChar, type Actor } from '@csd/core';
import { ContactsService, ProjectsService, type InvoiceInput } from '../src/index.js';
import { appPool, superPool } from './helpers.js';

export const gstin = (first14: string) => first14 + gstinCheckChar(first14);

let n = 0;

/** A client in `stateCode` and an active project for it. */
export async function clientProject(owner: Actor, stateCode = '33', name = `Client ${++n}`) {
  const clientId = await new ContactsService(appPool).create(owner, {
    type: 'client',
    name,
    stateCode,
    gstin: stateCode === '29' ? gstin('29AAKFV7731M1Z') : null,
    address: 'Chennai',
  });
  const { id: projectId } = await new ProjectsService(appPool).create(owner, {
    name: `Project for ${name}`,
    clientId,
    startDate: '2026-04-01',
    contractValue: 10_00_000_00,
    costBudget: 7_50_000_00,
  });
  return { clientId, projectId };
}

export const invoiceInput = (
  projectId: string,
  over: Partial<InvoiceInput> = {},
): InvoiceInput => ({
  projectId,
  invoiceDate: '2026-10-10',
  dueDate: '2026-10-25',
  lines: [
    {
      description: 'Office interiors – stage 1',
      qtyMilli: 1000,
      unit: 'lot',
      rate: 10_00_000_00,
      gstRate: 18,
    },
  ],
  ...over,
});

/** Debit and credit totals across the whole company journal (trial balance check). */
export async function trialBalance(companyId: string): Promise<{ dr: string; cr: string }> {
  const { rows } = await superPool.query<{ dr: string; cr: string }>(
    `SELECT coalesce(sum(debit), 0)::text AS dr, coalesce(sum(credit), 0)::text AS cr FROM journal_line WHERE company_id = $1`,
    [companyId],
  );
  return rows[0]!;
}

/** Net balance (debit − credit) of one account. */
export async function accountBalance(companyId: string, code: string): Promise<number> {
  const { rows } = await superPool.query<{ net: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS net
       FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.company_id = $1 AND a.code = $2`,
    [companyId, code],
  );
  return Math.round(Number(rows[0]!.net) * 100);
}

export async function setLock(companyId: string, date: string | null): Promise<void> {
  await superPool.query('UPDATE company SET lock_date = $2 WHERE id = $1', [companyId, date]);
}
