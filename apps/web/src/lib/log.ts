import { mapPlainDeep } from '@csd/core';

/**
 * Exact key names (or *Token / *Secret suffixes) whose values never reach the logs. A Postgres
 * error's `detail`, `where` and `parameters` quote row values ("Failing row contains (…)", with
 * PAN, bank or phone in it), so they are dropped too (BUG-186).
 */
const SECRET_KEY =
  /^(password|currentPassword|newPassword|passwordHash|password_hash|authorization|cookie|set-cookie|pan|bankAcc|bank_acc|phone|mobile|token|detail|where|parameters)$|(Token|_token|Secret|_secret)$/;

export function redactForLog(fields: Record<string, unknown>): unknown {
  return mapPlainDeep(fields, (k, v) => [k, SECRET_KEY.test(k) ? '[redacted]' : v]);
}

/** Structured JSON logs to stderr with secrets redacted (ENGINEERING-STANDARDS §2, §10.2). */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redactForLog(fields) as object) })}\n`,
  );
}
