import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gstinCheckChar, roleTemplate, type Actor } from '@csd/core';
import {
  OWNER_PASSWORD,
  client,
  closePools,
  emailOf,
  makeCompany,
  makeServices,
  setPassword,
  appPool,
  superPool,
  type Fixture,
} from './helpers.js';
import { InvoicesService } from '../src/index.js';
import { clientProject, invoiceInput } from './sales-helpers.js';

const s = makeServices();
let f: Fixture;
let owner: Actor;

/** A synthetic GSTIN with a correct check digit. */
const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const TN = gstin('33AAAPZ1234Q1Z');
const KA = gstin('29AAAPZ1234Q1Z');

beforeAll(async () => {
  f = await makeCompany('Settings Co');
  await setPassword(f.ownerId, OWNER_PASSWORD);
  const t = await s.auth.login(await emailOf(f.ownerId), OWNER_PASSWORD, client);
  owner = (await s.auth.authenticate(t.accessToken)).actor;
});
afterAll(closePools);

const actorAs = (role: 'admin' | 'auditor'): Actor => ({
  userId: f.ownerId,
  companyId: f.companyId,
  role,
  rights: roleTemplate(role),
  projects: 'all',
  active: true,
});

describe('company details (GO-LIVE §6 step 3)', () => {
  it('only the owner can read or edit the company details form', async () => {
    for (const role of ['admin', 'auditor'] as const) {
      await expect(s.settings.profile(actorAs(role))).rejects.toMatchObject({ status: 403 });
      await expect(
        s.settings.updateCompany(actorAs(role), { name: 'Hijack' }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('owner saves the letterhead; blanks clear a field; omitted fields are kept', async () => {
    await s.settings.updateCompany(owner, {
      name: 'Settings Co',
      legalName: 'Settings Co Interiors',
      gstin: TN.toLowerCase(),
      stateCode: '33',
      address: '12, First Street\nChennai 600001',
      phone: '044 2345 6789',
      email: 'Accounts@Settings.Example.Test',
      bankName: 'Example Bank',
      bankAccount: '001234567890',
      bankIfsc: 'exmp0001234',
      bankBranch: 'Adyar',
    });
    expect(await s.settings.letterhead(owner)).toEqual({
      name: 'Settings Co',
      legalName: 'Settings Co Interiors',
      gstin: TN,
      stateCode: '33',
      address: '12, First Street\nChennai 600001',
      phone: '044 2345 6789',
      email: 'accounts@settings.example.test',
      bankName: 'Example Bank',
      bankAccount: '001234567890',
      bankIfsc: 'EXMP0001234',
      bankBranch: 'Adyar',
    });

    await s.settings.updateCompany(owner, { bankBranch: '', phone: '+91 98400 12345' });
    const after = await s.settings.profile(owner);
    expect(after.bankBranch).toBeNull();
    expect(after.phone).toBe('+91 98400 12345');
    expect(after.legalName).toBe('Settings Co Interiors');
  });

  it('the GSTIN must be valid and match the state; changing state alone is checked too', async () => {
    await expect(s.settings.updateCompany(owner, { gstin: KA })).rejects.toMatchObject({
      field: 'gstin',
    });
    await expect(s.settings.updateCompany(owner, { stateCode: '29' })).rejects.toMatchObject({
      field: 'gstin',
    });
    const typo = TN.slice(0, 14) + (TN.endsWith('A') ? 'B' : 'A');
    await expect(s.settings.updateCompany(owner, { gstin: typo })).rejects.toThrow('check digit');
    await s.settings.updateCompany(owner, { gstin: KA, stateCode: '29' });
    expect((await s.settings.companyInfo(owner)).stateCode).toBe('29');
    await s.settings.updateCompany(owner, { gstin: TN, stateCode: '33' });
  });

  it('the state is locked once a document exists (it drives the GST split on reprints)', async () => {
    await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [
      f.companyId,
    ]);
    const { projectId } = await clientProject(owner);
    await new InvoicesService(appPool).create(owner, invoiceInput(projectId));
    await expect(
      s.settings.updateCompany(owner, { gstin: KA, stateCode: '29' }),
    ).rejects.toMatchObject({ field: 'stateCode' });
    // Everything else stays editable.
    await s.settings.updateCompany(owner, { phone: '044 1111 2222' });
    expect((await s.settings.profile(owner)).stateCode).toBe('33');
  });

  it('rejects a blank name and malformed contact or bank fields', async () => {
    const cases = [
      [{ name: '  ' }, 'name'],
      [{ email: 'not-an-email' }, 'email'],
      [{ phone: 'call me' }, 'phone'],
      [{ bankAccount: '12-34' }, 'bankAccount'],
      [{ bankIfsc: 'SBIN1234567' }, 'bankIfsc'],
      [{ stateCode: '99' }, 'stateCode'],
    ] as const;
    for (const [input, field] of cases) {
      await expect(s.settings.updateCompany(owner, input)).rejects.toMatchObject({ field });
    }
  });

  it('every change is audited with the bank account masked', async () => {
    await s.settings.updateCompany(owner, { bankAccount: '009876543210' });
    const { rows } = await superPool.query(
      `SELECT before, after FROM audit_log
        WHERE company_id = $1 AND action = 'update' AND entity = 'company' ORDER BY id DESC LIMIT 1`,
      [f.companyId],
    );
    expect(rows[0].before.bankAccount).toBe('••••7890');
    expect(rows[0].after.bankAccount).toBe('••••3210');
    expect(JSON.stringify(rows[0])).not.toContain('009876543210');
  });
});
