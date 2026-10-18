import { describe, expect, it } from 'vitest';
import { roleTemplate, type Role } from '@csd/core';
import { navFor } from '../src/lib/nav';

const labels = (role: Role) =>
  navFor({
    userId: 'u',
    companyId: 'c',
    role,
    rights: roleTemplate(role),
    projects: 'all',
    active: true,
  })
    .flatMap((g) => g.items)
    .map((i) => i.label);

describe('navigation follows rights (FR-3.4.1)', () => {
  it('owner sees everything including Users & security', () => {
    expect(labels('owner')).toContain('Users & security');
    expect(labels('owner')).toContain('Approvals');
  });
  it('admin and PM never see Users & security or Approvals; PM has no banking or payroll', () => {
    for (const role of ['admin', 'manager'] as const) {
      expect(labels(role)).not.toContain('Users & security');
      expect(labels(role)).not.toContain('Approvals');
    }
    expect(labels('manager')).not.toContain('Cash, bank & UPI');
    expect(labels('manager')).not.toContain('Payroll');
  });
  it('the auditor gets the audit trail entry, nobody else does', () => {
    expect(labels('auditor')).toContain('Audit trail');
    expect(labels('owner')).not.toContain('Audit trail');
    expect(labels('admin')).not.toContain('Audit trail');
  });
  it('site engineer sees only projects, expenses and inventory; empty groups are dropped', () => {
    expect(labels('site')).toEqual(['Projects', 'Expenses', 'Inventory']);
  });
});
