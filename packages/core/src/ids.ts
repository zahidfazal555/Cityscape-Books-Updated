import { DomainError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Path/body ids that are not UUIDs cannot exist: answer 404 instead of a database error. */
export function assertId(value: unknown, what = 'Record'): string {
  if (!isUuid(value)) throw new DomainError('NOT_FOUND', `${what} not found.`);
  return value;
}
