import { DomainError } from '@csd/core';
import { z } from 'zod';

/** Parses a request body or query; the first problem becomes a 422 on that field. */
export function input<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new DomainError('VALIDATION', issue?.message ?? 'Check the form.', issue?.path.join('.'));
  }
  return r.data;
}

export const credentials = z.object({
  email: z.string().trim().min(1, 'Enter your work email.').max(254),
  password: z.string().min(1, 'Enter your password.').max(128),
});
export const emailOnly = z.object({ email: z.string().trim().max(254) });
export const tokenAndPassword = z.object({
  token: z.string().min(10).max(200),
  password: z.string().max(128),
});
export const changePassword = z.object({
  currentPassword: z.string().max(128),
  newPassword: z.string().max(128),
});
export const lockDate = z.object({ lockDate: z.string().nullable() });
