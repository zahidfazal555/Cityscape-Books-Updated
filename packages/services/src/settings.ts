import { DomainError, parseIsoDate, todayIn, type Actor, type IsoDate } from '@csd/core';
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

export class SettingsService {
  constructor(private readonly pool: pg.Pool) {}

  /** What every signed-in user may see: company name, lock date and FY (header, nav, dates). */
  async companyInfo(
    actor: Actor,
  ): Promise<Pick<CompanySettings, 'name' | 'lockDate' | 'fyStartMonth'>> {
    if (!actor.active) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    const { name, lockDate, fyStartMonth } = await this.read(actor);
    return { name, lockDate, fyStartMonth };
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
