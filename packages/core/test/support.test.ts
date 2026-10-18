import { describe, expect, it } from 'vitest';
import {
  addMonths,
  canMoveTicket,
  coverageFor,
  fillTemplate,
  formatDuration,
  slaDue,
  slaState,
  warrantyEnd,
  warrantyStatus,
} from '../src/index.js';

const at = (s: string) => new Date(s);

describe('support SLA (FR-19.4/19.5)', () => {
  it('a High ticket logged at 11:00 is due a response by 15:00 and is overdue after', () => {
    const created = at('2026-10-17T11:00:00+05:30');
    const due = slaDue(created, 'high');
    expect(due.response.toISOString()).toBe(at('2026-10-17T15:00:00+05:30').toISOString());
    expect(due.resolution.toISOString()).toBe(at('2026-10-18T11:00:00+05:30').toISOString());
    expect(slaState(created, due.response, null, at('2026-10-17T15:30:00+05:30'))).toEqual({
      kind: 'overdue',
      ms: 30 * 60_000,
    });
    expect(slaState(created, due.response, null, at('2026-10-17T14:10:00+05:30'))).toMatchObject({
      kind: 'due',
      soon: true,
    });
    expect(slaState(created, due.response, null, at('2026-10-17T12:00:00+05:30'))).toMatchObject({
      kind: 'due',
      soon: false,
    });
  });

  it('a stamped response reads as met or missed, with the time it took', () => {
    const created = at('2026-10-17T09:00:00Z');
    const due = slaDue(created, 'urgent').response;
    expect(slaState(created, due, at('2026-10-17T09:40:00Z'), at('2026-10-18T00:00:00Z'))).toEqual({
      kind: 'met',
      ms: 40 * 60_000,
    });
    expect(
      slaState(created, due, at('2026-10-17T11:00:00Z'), at('2026-10-18T00:00:00Z')).kind,
    ).toBe('missed');
    expect([45, 200, 60 * 26].map((m) => formatDuration(m * 60_000))).toEqual([
      '45m',
      '3h 20m',
      '1d 2h',
    ]);
  });
});

describe('warranty and coverage (FR-19.7, FR-20)', () => {
  it('adds calendar months, clamping at the month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-11-15', 2)).toBe('2028-01-15');
    expect(warrantyEnd('2026-01-01', 12)).toBe('2026-12-31');
  });

  it('marks expiring within 60 days and expired after the end', () => {
    expect(warrantyStatus(null, 12, '2026-10-17').status).toBe('not_handed_over');
    expect(warrantyStatus('2025-12-01', 12, '2026-10-17')).toMatchObject({
      status: 'expiring',
      daysLeft: 44,
    });
    expect(warrantyStatus('2025-06-01', 12, '2026-10-17').status).toBe('expired');
    expect(warrantyStatus('2026-06-01', 12, '2026-10-17').status).toBe('in_warranty');
  });

  it('decides coverage by type, handover, warranty and AMC', () => {
    const p = { handoverDate: '2025-06-01', warrantyMonths: 12, amcUntil: '2027-01-01' };
    expect(coverageFor('snag', p, '2026-10-17')).toBe('chargeable');
    expect(coverageFor('warranty', { ...p, warrantyMonths: 24 }, '2026-10-17')).toBe('warranty');
    expect(coverageFor('service', { ...p, handoverDate: null }, '2026-10-17')).toBe('contract');
    expect(coverageFor('amc', p, '2026-10-17')).toBe('amc');
    expect(coverageFor('amc', { ...p, amcUntil: null }, '2026-10-17')).toBe('chargeable');
    expect(coverageFor('change', p, '2026-10-17')).toBe('chargeable');
    expect(coverageFor('billing', p, '2026-10-17')).toBe('na');
  });
});

describe('ticket moves and templates (FR-19.3, FR-19.8)', () => {
  it('a scheduled visit blocks resolving; resolved and closed tickets can reopen', () => {
    expect(canMoveTicket('visit_scheduled', 'resolved')).toBe(false);
    expect(canMoveTicket('visit_scheduled', 'closed')).toBe(false);
    expect(canMoveTicket('open', 'visit_scheduled')).toBe(false);
    expect(canMoveTicket('closed', 'open')).toBe(true);
    expect(canMoveTicket('resolved', 'closed')).toBe(true);
  });

  it('fills known placeholders and leaves unknown ones', () => {
    expect(
      fillTemplate('Hi {client}, ticket {ticket} for {project} — {x}', {
        client: 'Hire Nexa',
        ticket: 'TKT-0001',
        project: 'CSD-PRJ-0001',
      }),
    ).toBe('Hi Hire Nexa, ticket TKT-0001 for CSD-PRJ-0001 — {x}');
  });
});
