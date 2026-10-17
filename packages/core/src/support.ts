import { addDays, daysBetween, parseIsoDate, type IsoDate } from './dates.js';

/** Support tickets (Req §4.19, Technical Spec §14). */
export const TICKET_TYPES = ['snag', 'warranty', 'service', 'amc', 'billing', 'change'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'awaiting_client',
  'visit_scheduled',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_CHANNELS = ['phone', 'walk_in', 'whatsapp', 'email', 'site_visit'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export type Coverage = 'warranty' | 'amc' | 'contract' | 'chargeable' | 'na';

/** FR-19.4: calendar hours from logging, by priority. */
export const SLA_HOURS: Readonly<Record<TicketPriority, { response: number; resolution: number }>> =
  {
    urgent: { response: 1, resolution: 4 },
    high: { response: 4, resolution: 24 },
    normal: { response: 8, resolution: 72 },
    low: { response: 24, resolution: 168 },
  };

const HOUR = 3_600_000;

export function slaDue(
  createdAt: Date,
  priority: TicketPriority,
): { response: Date; resolution: Date } {
  const h = SLA_HOURS[priority];
  return {
    response: new Date(createdAt.getTime() + h.response * HOUR),
    resolution: new Date(createdAt.getTime() + h.resolution * HOUR),
  };
}

export type SlaState =
  | { kind: 'due'; ms: number; soon: boolean }
  | { kind: 'overdue'; ms: number }
  | { kind: 'met'; ms: number }
  | { kind: 'missed'; ms: number };

/**
 * One SLA clock (FR-19.5): "Due in …" (soon when 25% or less of the target is left),
 * "Overdue by …", "Responded in …" or "Missed · took …".
 */
export function slaState(createdAt: Date, due: Date, doneAt: Date | null, now: Date): SlaState {
  if (doneAt) {
    const took = doneAt.getTime() - createdAt.getTime();
    return doneAt <= due ? { kind: 'met', ms: took } : { kind: 'missed', ms: took };
  }
  const left = due.getTime() - now.getTime();
  if (left < 0) return { kind: 'overdue', ms: -left };
  const target = due.getTime() - createdAt.getTime();
  return { kind: 'due', ms: left, soon: left * 4 <= target };
}

/** "3h 20m", "2d 4h", "45m". */
export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return min > 0 ? `${h}h ${min}m` : `${h}h`;
  return `${min}m`;
}

/** `value` + `months` calendar months, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(value: IsoDate, months: number): IsoDate {
  const { y, m, d } = parseIsoDate(value);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const WARRANTY_MONTHS = [6, 12, 24, 60] as const;
export type WarrantyMonths = (typeof WARRANTY_MONTHS)[number];

/** Last day covered: a 12-month warranty from 1 Jan 2026 runs to 31 Dec 2026. */
export function warrantyEnd(handover: IsoDate, months: number): IsoDate {
  return addDays(addMonths(handover, months), -1);
}

export type WarrantyStatus = 'not_handed_over' | 'in_warranty' | 'expiring' | 'expired';

/** FR-20.1: "Expiring soon" when 60 days or fewer are left. */
export function warrantyStatus(
  handover: IsoDate | null,
  months: number,
  today: IsoDate,
): { status: WarrantyStatus; end: IsoDate | null; daysLeft: number | null } {
  if (!handover) return { status: 'not_handed_over', end: null, daysLeft: null };
  const end = warrantyEnd(handover, months);
  const daysLeft = daysBetween(today, end);
  if (daysLeft < 0) return { status: 'expired', end, daysLeft };
  return { status: daysLeft <= 60 ? 'expiring' : 'in_warranty', end, daysLeft };
}

/**
 * FR-19.7: coverage is decided when the ticket is logged and stored with it. Snags, warranty
 * claims and service: under contract before handover, free within the warranty, chargeable after.
 * An AMC visit is covered while the AMC runs; a change request is always chargeable.
 */
export function coverageFor(
  type: TicketType,
  project: { handoverDate: IsoDate | null; warrantyMonths: number; amcUntil: IsoDate | null },
  today: IsoDate,
): Coverage {
  if (type === 'billing') return 'na';
  if (type === 'change') return 'chargeable';
  if (type === 'amc') return project.amcUntil && today <= project.amcUntil ? 'amc' : 'chargeable';
  if (!project.handoverDate) return 'contract';
  return today <= warrantyEnd(project.handoverDate, project.warrantyMonths)
    ? 'warranty'
    : 'chargeable';
}

/** FR-19.3: the statuses a ticket may move to from each status. */
const MOVES: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['in_progress', 'awaiting_client', 'resolved', 'closed'],
  in_progress: ['open', 'awaiting_client', 'resolved', 'closed'],
  awaiting_client: ['open', 'in_progress', 'resolved', 'closed'],
  // Left only by completing or cancelling the visit.
  visit_scheduled: ['in_progress', 'awaiting_client'],
  resolved: ['closed', 'open', 'in_progress'],
  closed: ['open', 'in_progress'],
};

export function canMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return MOVES[from].includes(to);
}

/** FR-19.8: fills {client} {ticket} {project} {engineer} {date}; unknown placeholders stay. */
export function fillTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}
