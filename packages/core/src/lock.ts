import { formatDate, parseIsoDate, type IsoDate } from './dates.js';
import { DomainError } from './errors.js';

/**
 * FR-3.3.1: nothing dated on or before the lock date may be created, edited or deleted,
 * by any role. Call this for the old date AND the new date when a document is edited.
 */
export function assertNotLocked(txnDate: IsoDate, lockDate: IsoDate | null, field = 'date'): void {
  parseIsoDate(txnDate, field);
  if (lockDate === null) return;
  if (txnDate <= lockDate) {
    throw new DomainError(
      'PERIOD_LOCKED',
      `Books are locked till ${formatDate(lockDate)}. Pick a later date.`,
      field,
    );
  }
}
