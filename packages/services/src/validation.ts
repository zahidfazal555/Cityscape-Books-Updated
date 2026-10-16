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
