import {
  formatDuration,
  slaState,
  type Coverage,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@csd/core';

/** Labels and SLA text for the support screens (README §18). Safe for client components. */
export const TYPE_LABEL: Record<TicketType, string> = {
  snag: 'Snag / defect',
  warranty: 'Warranty claim',
  service: 'Service & repair',
  amc: 'AMC visit',
  billing: 'Billing query',
  change: 'Change request',
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};
export const PRIORITY_TONE = { urgent: 'red', high: 'amber', normal: 'blue', low: 'grey' } as const;
export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_client: 'Awaiting client',
  visit_scheduled: 'Visit scheduled',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const STATUS_TONE = {
  open: 'blue',
  in_progress: 'amber',
  awaiting_client: 'grey',
  visit_scheduled: 'blue',
  resolved: 'green',
  closed: 'grey',
} as const;
export const CHANNEL_LABEL: Record<TicketChannel, string> = {
  phone: 'Phone call',
  walk_in: 'Walk-in',
  whatsapp: 'WhatsApp',
  email: 'Email',
  site_visit: 'Site visit',
};
export const COVERAGE_LABEL: Record<Coverage, string> = {
  warranty: 'In warranty · free',
  amc: 'AMC · covered',
  contract: 'Under contract (not handed over)',
  chargeable: 'Chargeable',
  na: 'Not applicable',
};
export const COVERAGE_TONE = {
  warranty: 'green',
  amc: 'green',
  contract: 'blue',
  chargeable: 'amber',
  na: 'grey',
} as const;
export const SLOT_LABEL = {
  morning: 'Morning 9–12',
  afternoon: 'Afternoon 12–4',
  evening: 'Evening 4–7',
} as const;
export const KB_CATEGORY_LABEL = {
  care: 'Care guide',
  warranty: 'Warranty',
  howto: 'How-to',
  checklist: 'Checklist',
} as const;
export const WARRANTY_LABEL = {
  not_handed_over: 'Not handed over',
  in_warranty: 'In warranty',
  expiring: 'Expiring soon',
  expired: 'Warranty expired',
} as const;
export const WARRANTY_TONE = {
  not_handed_over: 'grey',
  in_warranty: 'green',
  expiring: 'amber',
  expired: 'red',
} as const;

/**
 * FR-19.5 text for one clock: "Due in …" (amber when 25% or less is left), "Overdue by …",
 * "Responded in …" / "Resolved in …", or "Missed · took …".
 */
export function slaText(
  createdAt: string,
  due: string,
  doneAt: string | null,
  now: Date,
  done = 'Responded',
): { text: string; tone: 'green' | 'amber' | 'red' | 'grey' } {
  const s = slaState(new Date(createdAt), new Date(due), doneAt ? new Date(doneAt) : null, now);
  if (s.kind === 'met') return { text: `${done} in ${formatDuration(s.ms)}`, tone: 'green' };
  if (s.kind === 'missed') return { text: `Missed · took ${formatDuration(s.ms)}`, tone: 'red' };
  if (s.kind === 'overdue') return { text: `Overdue by ${formatDuration(s.ms)}`, tone: 'red' };
  return { text: `Due in ${formatDuration(s.ms)}`, tone: s.soon ? 'amber' : 'grey' };
}
