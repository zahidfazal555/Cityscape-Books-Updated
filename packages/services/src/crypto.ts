import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Only its hash is ever stored. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
