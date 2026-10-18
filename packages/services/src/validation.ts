import { DomainError, parseIsoDate } from '@csd/core';
import type pg from 'pg';
import { z } from 'zod';

/** Parses service input with zod and turns the first issue into a 422 on that field. */
export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DomainError('VALIDATION', issue?.message ?? 'Check the form.', issue?.path.join('.'));
  }
  return result.data;
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

/** Re-throws a unique violation as a friendly 422 on `field`. */
export function onDuplicate(field: string, message: string): (e: unknown) => never {
  return (e: unknown) => {
    throw isUniqueViolation(e) ? new DomainError('VALIDATION', message, field) : e;
  };
}

/** Tenant context for an authenticated actor. */
export function tenantOf(actor: { companyId: string; userId: string }): {
  companyId: string;
  userId: string;
} {
  return { companyId: actor.companyId, userId: actor.userId };
}

/** Partial-update merge: `undefined` keeps the old value, `null` clears it. */
export function pick<T>(value: T | undefined, old: T): T {
  return value === undefined ? old : value;
}

/** Escapes LIKE/ILIKE wildcards so user search text matches literally (use with ESCAPE '\'). */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Form fields often arrive as '' for "not given": treat them as null before validating. */
/** How a list or report leaves the app; recorded on the export's audit row (H4). */
export type ExportFormat = 'csv' | 'pdf';

export function blankToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/** PAN shown as •••••1234F unless the viewer may see it in full. */
export function maskPan(pan: string | null): string | null {
  return pan === null ? null : `•••••${pan.slice(5)}`;
}

/** YYYY-MM-DD that is a real calendar date. */
export const isoDate = z.string().refine((d) => {
  try {
    parseIsoDate(d);
    return true;
  } catch {
    return false;
  }
}, 'Enter a valid date.');

export interface CompanyRow {
  lock_date: string | null;
  fy_start_month: number;
  state_code: string;
}

/** Lock date, FY start and the company's GST state, read inside the caller's transaction. */
export async function companyRow(c: pg.PoolClient): Promise<CompanyRow> {
  const { rows } = await c.query<CompanyRow>(
    `SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date, fy_start_month, state_code FROM company`,
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Company not found.');
  return row;
}
