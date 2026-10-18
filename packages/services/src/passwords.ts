import { hash, verify } from '@node-rs/argon2';
import { DomainError } from '@csd/core';
import { createHash } from 'node:crypto';

/** OWASP-recommended argon2id parameters (ENGINEERING-STANDARDS §2). */
const ARGON2 = {
  algorithm: 2 /* argon2id */,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A real argon2id hash used to spend the same time when the email is unknown (no timing oracle). */
let dummyHash: Promise<string> | undefined;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return dummyHash.then((h) => verifyPassword(h, password));
}

/** Checks a password against known breaches. Production uses HIBP k-anonymity. */
export interface BreachChecker {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Have I Been Pwned range API: only the first 5 hex chars of the SHA-1 leave the server.
 * Fails open (returns false) if the service is unreachable, so sign-up is never blocked by
 * an outage; the length and context rules still apply.
 */
export class HibpBreachChecker implements BreachChecker {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 3_000,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await this.fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return false;
      const body = await res.text();
      return body.split('\n').some((line) => {
        const [s, count] = line.trim().split(':');
        return s === suffix && Number(count) > 0;
      });
    } catch {
      return false;
    }
  }
}

/** Validates a new password (Tech Spec §7): 12–128 chars, not the user's own details, not breached. */
export async function assertPasswordPolicy(
  password: string,
  context: { email: string; name: string },
  breach: BreachChecker,
): Promise<void> {
  const fail = (message: string): never => {
    throw new DomainError('VALIDATION', message, 'password');
  };
  if (password.length < PASSWORD_MIN) fail(`Use at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) fail(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  const local = context.email.split('@')[0]?.toLowerCase() ?? '';
  const nameParts = context.name
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 4);
  if ((local.length >= 4 && lower.includes(local)) || nameParts.some((p) => lower.includes(p))) {
    fail('Do not use your name or email in the password.');
  }
  if (new Set(password).size < 5) fail('Use a less repetitive password.');
  if (await breach.isBreached(password)) {
    fail('This password has appeared in a data breach. Choose a different one.');
  }
}
