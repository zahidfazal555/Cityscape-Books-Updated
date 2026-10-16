/** One error shape for the whole system: `{ code, message, field? }` mapped to an HTTP status. */
export type ErrorCode =
  'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'PERIOD_LOCKED';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  PERIOD_LOCKED: 423,
};

export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = STATUS[code];
  }

  toJSON(): { code: ErrorCode; message: string; field?: string } {
    return this.field === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, field: this.field };
  }
}
