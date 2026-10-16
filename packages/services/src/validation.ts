import { DomainError } from '@csd/core';
import type { z } from 'zod';

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
export function blankToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/** PAN shown as •••••1234F unless the viewer may see it in full. */
export function maskPan(pan: string | null): string | null {
  return pan === null ? null : `•••••${pan.slice(5)}`;
}
