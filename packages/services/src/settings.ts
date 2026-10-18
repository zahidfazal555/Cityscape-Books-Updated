import {
  DomainError,
  STATE_CODES,
  can,
  parseIsoDate,
  todayIn,
  validateGstin,
  type Actor,
  type IsoDate,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { assertOwner } from './users.js';
import { blankToNull, parse } from './validation.js';

export interface CompanySettings {
  name: string;
  gstin: string | null;
  stateCode: string;
  lockDate: IsoDate | null;
  fyStartMonth: number;
  requireBillAttachment: boolean;
}

export interface Letterhead {
  name: string;
  legalName: string | null;
  gstin: string | null;
  stateCode: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
}

const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

/** Company details printed on every document (GO-LIVE §6 step 3). Omitted fields are kept. */
const companyUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter the company name.').max(160),
    legalName: optionalText(200),
    gstin: optionalText(15),
    stateCode: z.string().refine((c) => c in STATE_CODES, 'Choose a state.'),
    address: optionalText(500),
    phone: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .regex(/^\+?[\d\s-]{6,20}$/, 'Enter a valid phone number.')
        .nullable()
        .optional(),
    ),
    email: z.preprocess(
      blankToNull,
      z.string().trim().toLowerCase().email('Enter a valid email.').nullable().optional(),
    ),
    bankName: optionalText(120),
    bankAccount: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .regex(/^\d{6,18}$/, 'Account number is 6 to 18 digits.')
        .nullable()
        .optional(),
    ),
    bankIfsc: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC is 11 characters, like SBIN0001234.')
        .nullable()
        .optional(),
    ),
    bankBranch: optionalText(120),
  })
  .partial();

export type CompanyUpdate = z.input<typeof companyUpdateSchema>;

const LETTERHEAD_SQL = `SELECT name, legal_name AS "legalName", gstin, state_code AS "stateCode", address, phone,
         email::text, bank_name AS "bankName", bank_acc AS "bankAccount", bank_ifsc AS "bankIfsc",
         bank_branch AS "bankBranch"
    FROM company`;

/** Bank account shown as ••••1234 in the audit trail (ENGINEERING-STANDARDS §9). */
function maskAccount(acc: string | null): string | null {
  return acc === null ? null : `••••${acc.slice(-4)}`;
}

/** Printed documents: sales, and purchase orders and bills (BUG-116). */
const SALES_DOCS = ['quotes', 'proformas', 'invoices', 'receipts', 'pos', 'bills'] as const;

async function readLetterhead(c: pg.PoolClient, forUpdate = false): Promise<Letterhead> {
  const { rows } = await c.query<Letterhead>(`${LETTERHEAD_SQL}${forUpdate ? ' FOR UPDATE' : ''}`);
  const r = rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Company not found.');
  return r;
}

async function hasDocuments(c: pg.PoolClient): Promise<boolean> {
  const { rows } = await c.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM quotation) OR EXISTS (SELECT 1 FROM proforma)
         OR EXISTS (SELECT 1 FROM invoice) OR EXISTS (SELECT 1 FROM purchase_order)
         OR EXISTS (SELECT 1 FROM bill) AS found`,
  );
  return rows[0]?.found ?? false;
}

export class SettingsService {
  constructor(private readonly pool: pg.Pool) {}

  /** What every signed-in user may see: company name, lock date and FY (header, nav, dates). */
  async companyInfo(
    actor: Actor,
  ): Promise<Pick<CompanySettings, 'name' | 'lockDate' | 'fyStartMonth' | 'stateCode' | 'gstin'>> {
    if (!actor.active) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    const { name, lockDate, fyStartMonth, stateCode, gstin } = await this.read(actor);
    // The GST state drives CGST+SGST vs IGST previews on every form (BUG-116); the GSTIN
    // decides whether a GSTR-1 file can be produced (BUG-138).
    return { name, lockDate, fyStartMonth, stateCode, gstin };
  }

  /**
   * What is printed on quotations, proformas, invoices and receipts. Anyone who can view one of
   * those documents can read it (bank details are printed for the client to pay into).
   */
  async letterhead(actor: Actor): Promise<Letterhead> {
    if (!SALES_DOCS.some((m) => can(actor, m, 'view')))
      throw new DomainError('FORBIDDEN', 'You do not have access to sales documents.');
    return withTenant(this.pool, { companyId: actor.companyId, userId: actor.userId }, async (c) =>
      readLetterhead(c),
    );
  }

  /** The company details form (Settings → Company): owner-only. */
  async profile(actor: Actor): Promise<Letterhead> {
    assertOwner(actor);
    return withTenant(this.pool, { companyId: actor.companyId, userId: actor.userId }, async (c) =>
      readLetterhead(c),
    );
  }

  /**
   * Owner-only. Edits the details printed on quotations, invoices, receipts, POs and bills.
   * The GSTIN must match the state (it decides CGST+SGST vs IGST). Audited, account masked.
   */
  async updateCompany(actor: Actor, input: CompanyUpdate): Promise<void> {
    assertOwner(actor);
    const data = parse(companyUpdateSchema, input);
    await withTenant(this.pool, { companyId: actor.companyId, userId: actor.userId }, async (c) => {
      const before = await readLetterhead(c, true);
      const given = Object.entries(data).filter(([, v]) => v !== undefined);
      const next: Letterhead = { ...before, ...Object.fromEntries(given) };
      next.gstin = next.gstin ? validateGstin(next.gstin, next.stateCode) : null;
      if (next.stateCode !== before.stateCode && (await hasDocuments(c))) {
        // Quotations, proformas and POs recompute CGST+SGST vs IGST from the company's state:
        // moving it would change the tax on documents already sent.
        throw new DomainError(
          'VALIDATION',
          'The state cannot change once documents exist. It decides CGST+SGST or IGST on them.',
          'stateCode',
        );
      }
      await c.query(
        `UPDATE company SET name = $1, legal_name = $2, gstin = $3, state_code = $4, address = $5,
                phone = $6, email = $7, bank_name = $8, bank_acc = $9, bank_ifsc = $10,
                bank_branch = $11, updated_by = app_user_id()`,
        [
          next.name,
          next.legalName,
          next.gstin,
          next.stateCode,
          next.address,
          next.phone,
          next.email,
          next.bankName,
          next.bankAccount,
          next.bankIfsc,
          next.bankBranch,
        ],
      );
      await writeAudit(c, {
        action: 'update',
        entity: 'company',
        entityId: actor.companyId,
        before: { ...before, bankAccount: maskAccount(before.bankAccount) },
        after: { ...next, bankAccount: maskAccount(next.bankAccount) },
      });
    });
  }

  /** Full company settings: Users & security is owner-only. */
  async get(actor: Actor): Promise<CompanySettings> {
    assertOwner(actor);
    return this.read(actor);
  }

  private async read(actor: Actor): Promise<CompanySettings> {
    return withTenant(
      this.pool,
      { companyId: actor.companyId, userId: actor.userId },
      async (c) => {
        const { rows } = await c.query<{
          name: string;
          gstin: string | null;
          state_code: string;
          lock_date: string | null;
          fy_start_month: number;
          require_bill_attachment: boolean;
        }>(`SELECT name, gstin, state_code, to_char(lock_date, 'YYYY-MM-DD') AS lock_date, fy_start_month,
                 require_bill_attachment FROM company`);
        const r = rows[0];
        if (!r) throw new DomainError('NOT_FOUND', 'Company not found.');
        return {
          name: r.name,
          gstin: r.gstin,
          stateCode: r.state_code,
          lockDate: r.lock_date,
          fyStartMonth: r.fy_start_month,
          requireBillAttachment: r.require_bill_attachment,
        };
      },
    );
  }

  /** Owner-only. Moving the lock date in either direction is audited (Tech Spec §3). */
  async setLockDate(actor: Actor, lockDate: IsoDate | null): Promise<void> {
    assertOwner(actor);
    if (lockDate !== null) {
      parseIsoDate(lockDate, 'lockDate');
      if (lockDate > todayIn('Asia/Kolkata')) {
        throw new DomainError('VALIDATION', 'The lock date cannot be in the future.', 'lockDate');
      }
    }
    await withTenant(this.pool, { companyId: actor.companyId, userId: actor.userId }, async (c) => {
      const { rows } = await c.query<{ lock_date: string | null }>(
        `SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date FROM company`,
      );
      await c.query('UPDATE company SET lock_date = $1', [lockDate]);
      await writeAudit(c, {
        action: 'lock_date_change',
        entity: 'company',
        entityId: actor.companyId,
        before: { lockDate: rows[0]?.lock_date ?? null },
        after: { lockDate },
      });
    });
  }
}
