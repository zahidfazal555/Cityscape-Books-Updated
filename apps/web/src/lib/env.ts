import { z } from 'zod';

/**
 * Typed, validated configuration (ENGINEERING-STANDARDS §1): the app refuses to start when a
 * required value is missing. Values come from the environment / secret manager, never the repo.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  /** base64 of at least 32 random bytes. */
  JWT_SECRET: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').byteLength >= 32,
      'JWT_SECRET must be base64 of ≥ 32 bytes',
    ),
  APP_URL: z.string().url(),
  /** 'outbox' keeps mail in memory (dev/test only). Production needs a real provider. */
  MAIL_MODE: z.enum(['outbox']).default('outbox'),
  /** Number of reverse proxies in front of the app, for client IP extraction. */
  TRUSTED_PROXIES: z.coerce.number().int().min(0).max(5).default(1),
  /** Only the e2e suite sets this: it runs a production build with the in-memory outbox. */
  CSD_ALLOW_OUTBOX_IN_PRODUCTION: z.literal('e2e').optional(),
  /** Sign-ins per IP per minute. At most 10 in production (ENGINEERING-STANDARDS §2), except the e2e run. */
  CSD_LOGIN_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${fields}`);
  }
  const e2e = parsed.data.CSD_ALLOW_OUTBOX_IN_PRODUCTION === 'e2e';
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MAIL_MODE === 'outbox' && !e2e) {
    throw new Error('Invalid configuration — production needs a real mail provider (MAIL_MODE).');
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.CSD_LOGIN_LIMIT_PER_MINUTE > 10 &&
    !e2e
  ) {
    throw new Error(
      'Invalid configuration — CSD_LOGIN_LIMIT_PER_MINUTE cannot exceed 10 in production.',
    );
  }
  cached = parsed.data;
  return cached;
}
