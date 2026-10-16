import 'server-only';

const SECRET = /pass(word)?|token|secret|authorization|cookie|pan|bank_?acc|phone/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SECRET.test(k) ? '[redacted]' : redact(v, depth + 1),
    ]),
  );
}

/** Structured JSON logs to stderr with secrets redacted (ENGINEERING-STANDARDS §2, §10.2). */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) })}\n`,
  );
}
