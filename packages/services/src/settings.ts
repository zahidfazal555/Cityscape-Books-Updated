import { DomainError, can, parseIsoDate, todayIn, type Actor, type IsoDate } from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { assertOwner } from './users.js';

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

/** Printed documents: sales, and purchase orders and bills (BUG-116). */
const SALES_DOCS = ['quotes', 'proformas', 'invoices', 'receipts', 'pos', 'bills'] as const;

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
    return withTenant(
      this.pool,
      { companyId: actor.companyId, userId: actor.userId },
      async (c) => {
        const { rows } = await c.query<Letterhead>(
          `SELECT name, legal_name AS "legalName", gstin, state_code AS "stateCode", address, phone, email::text,
                  bank_name AS "bankName", bank_acc AS "bankAccount", bank_ifsc AS "bankIfsc",
                  bank_branch AS "bankBranch"
             FROM company`,
        );
        const r = rows[0];
        if (!r) throw new DomainError('NOT_FOUND', 'Company not found.');
        return r;
      },
    );
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
