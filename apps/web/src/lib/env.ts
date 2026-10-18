import { z } from 'zod';

/**
 * Typed, validated configuration (ENGINEERING-STANDARDS §1): the app refuses to start when a
 * required value is missing. Values come from the environment / secret manager, never the repo.
 */
const blank = (v: unknown) => (v === '' ? undefined : v);

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
  /** 'outbox' keeps mail in memory (dev/test only); 'smtp' sends through SMTP_URL. */
  MAIL_MODE: z.enum(['outbox', 'smtp']).default('outbox'),
  /** smtps://user:pass@host:465 (implicit TLS) or smtp://user:pass@host:587 (STARTTLS required). */
  // A blank line in .env means "not set" (BUG-177).
  SMTP_URL: z.preprocess(
    blank,
    z
      .string()
      .regex(/^smtps?:\/\//, 'SMTP_URL must start with smtps:// or smtp://')
      .optional(),
  ),
  /** Sender, e.g. "Cityscape Books <books@cityscapedecors.in>". */
  MAIL_FROM: z.preprocess(blank, z.string().min(3).optional()),
  /** Number of reverse proxies in front of the app, for client IP extraction. */
  TRUSTED_PROXIES: z.coerce.number().int().min(0).max(5).default(1),
  /** Only the e2e suite sets this: it runs a production build with the in-memory outbox. */
  CSD_ALLOW_OUTBOX_IN_PRODUCTION: z.literal('e2e').optional(),
  /** Sign-ins per IP per minute. At most 10 in production (ENGINEERING-STANDARDS §2), except the e2e run. */
  CSD_LOGIN_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  /** Private directory for bill photos (FileBlobStore). Outside the web root; required in production. */
  ATTACHMENT_DIR: z.string().min(1).optional(),
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
  assertProduction(parsed.data);
  cached = parsed.data;
  return cached;
}

/** Settings that are only safe outside production are refused there (fail fast at start-up). */
function assertProduction(e: Env): void {
  const broken = configRules(e).find(([bad]) => bad);
  if (broken) throw new Error(`Invalid configuration — ${broken[1]}`);
}

function configRules(e: Env): [boolean, string][] {
  const prod = e.NODE_ENV === 'production';
  const e2e = e.CSD_ALLOW_OUTBOX_IN_PRODUCTION === 'e2e';
  return [
    [
      prod && e.MAIL_MODE === 'outbox' && !e2e,
      'production needs a real mail provider (MAIL_MODE).',
    ],
    [
      prod && e.CSD_LOGIN_LIMIT_PER_MINUTE > 10 && !e2e,
      'CSD_LOGIN_LIMIT_PER_MINUTE cannot exceed 10 in production.',
    ],
    [
      e.MAIL_MODE === 'smtp' && (!e.SMTP_URL || !e.MAIL_FROM),
      'MAIL_MODE=smtp needs SMTP_URL and MAIL_FROM.',
    ],
    [prod && !e.ATTACHMENT_DIR, 'ATTACHMENT_DIR is required in production.'],
    // Without a proxy every client shares one "unknown" rate-limit bucket, so one attacker could
    // block sign-in for everyone (BUG-185).
    [
      prod && e.TRUSTED_PROXIES === 0 && !e2e,
      'TRUSTED_PROXIES must be at least 1 in production: run the app behind the HTTPS proxy.',
    ],
  ];
}
