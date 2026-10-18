import { daysBetween, type IsoDate } from './dates.js';

/** Outstanding ageing buckets (Req FR-14.1), by days past the due date. */
export const AGEING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const AGEING_LABEL: Readonly<Record<AgeingBucket, string>> = {
  current: 'Current',
  d1_30: '1–30',
  d31_60: '31–60',
  d61_90: '61–90',
  d90_plus: '90+',
};

/** Days overdue as of `today` (0 when not yet due). */
export function daysOverdue(dueDate: IsoDate, today: IsoDate): number {
  return Math.max(0, daysBetween(dueDate, today));
}

export function ageingBucket(overdue: number): AgeingBucket {
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'd1_30';
  if (overdue <= 60) return 'd31_60';
  if (overdue <= 90) return 'd61_90';
  return 'd90_plus';
}

/** FR-14.1 status colour: amber once overdue, red past 60 days. */
export function overdueTone(overdue: number): 'none' | 'amber' | 'red' {
  if (overdue > 60) return 'red';
  return overdue > 0 ? 'amber' : 'none';
}
