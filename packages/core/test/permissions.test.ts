import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LEVELS,
  MODULES,
  ROLES,
  authorize,
  can,
  hasCustomRights,
  projectScope,
  requiresApproval,
  roleTemplate,
  stripPnl,
  validateRights,
  type Actor,
  type Role,
} from '../src/index.js';

const actor = (role: Role, extra: Partial<Actor> = {}): Actor => ({
  userId: 'u',
  companyId: 'c',
  role,
  rights: roleTemplate(role),
  projects: 'all',
  active: true,
  ...extra,
});

describe('role templates (Requirements §2.3)', () => {
  it('every template uses only levels allowed for each module', () => {
    for (const role of ROLES) {
      const t = roleTemplate(role);
      for (const m of MODULES) expect(ALLOWED_LEVELS[m]).toContain(t[m]);
    }
  });

  it('has 21 modules', () => expect(MODULES).toHaveLength(21));

  it('only the owner approves or sees profit by default; auditor sees profit read-only', () => {
    for (const role of ROLES) {
      const a = actor(role);
      expect(can(a, 'approvals', 'full')).toBe(role === 'owner');
      expect(can(a, 'pnl', 'view')).toBe(role === 'owner' || role === 'auditor');
    }
  });

  it('UAT 7: project manager has no P&L, approvals, banking or payroll', () => {
    const pm = actor('manager');
    for (const m of ['pnl', 'approvals', 'banking', 'payroll'] as const) {
      expect(can(pm, m, 'view')).toBe(false);
    }
    expect(can(pm, 'invoices', 'edit')).toBe(true);
    expect(can(pm, 'invoices', 'full')).toBe(false);
  });

  it('auditor can never write anything', () => {
    const a = actor('auditor');
    for (const m of MODULES) expect(can(a, m, 'edit')).toBe(false);
  });

  it('asst. manager handles tickets, edits POs, views invoices', () => {
    const a = actor('asstmgr');
    expect(can(a, 'tickets', 'full')).toBe(true);
    expect(can(a, 'pos', 'edit')).toBe(true);
    expect(can(a, 'invoices', 'view')).toBe(true);
    expect(can(a, 'invoices', 'edit')).toBe(false);
  });
});

describe('can() and authorize()', () => {
  it('owner always passes, even with an empty rights map', () => {
    const owner = actor('owner', { rights: roleTemplate('auditor'), projects: [] });
    expect(can(owner, 'payroll', 'full', 'P9')).toBe(true);
  });

  it('inactive users fail everything', () => {
    expect(can(actor('owner', { active: false }), 'dashboard', 'view')).toBe(false);
  });

  it('UAT 8: scoped users only reach their projects', () => {
    const se = actor('site', { projects: ['P1', 'P5'] });
    expect(can(se, 'expenses', 'edit', 'P1')).toBe(true);
    expect(can(se, 'expenses', 'edit', 'P2')).toBe(false);
    expect(projectScope(se)).toEqual(['P1', 'P5']);
    expect(projectScope(actor('admin'))).toBeNull();
    expect(projectScope(actor('owner', { projects: ['P1'] }))).toBeNull();
  });

  it('authorize throws 403', () => {
    expect(() => authorize(actor('site'), 'payroll', 'view')).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => authorize(actor('admin'), 'payroll', 'full')).not.toThrow();
  });
});

describe('rights editing', () => {
  it('accepts a full valid map and flags custom rights', () => {
    const rights = { ...roleTemplate('manager'), banking: 'view' } as Record<string, string>;
    const parsed = validateRights(rights);
    expect(hasCustomRights('manager', parsed)).toBe(true);
    expect(hasCustomRights('manager', roleTemplate('manager'))).toBe(false);
  });

  it('rejects levels a module does not allow, missing and unknown modules', () => {
    const base = roleTemplate('manager') as Record<string, string>;
    expect(() => validateRights({ ...base, approvals: 'view' })).toThrow('approvals');
    expect(() => validateRights({ ...base, pnl: 'full' })).toThrow('pnl');
    const { gst: _gst, ...missing } = base;
    expect(() => validateRights(missing)).toThrow('gst');
    expect(() => validateRights({ ...base, users: 'full' })).toThrow('Unknown module: users');
  });
});

describe('approvals (H2) and P&L stripping', () => {
  it('everyone except approvers saves Pending', () => {
    expect(requiresApproval(actor('owner'))).toBe(false);
    expect(requiresApproval(actor('admin'))).toBe(true);
    const delegated = actor('admin', { rights: { ...roleTemplate('admin'), approvals: 'full' } });
    expect(requiresApproval(delegated)).toBe(false);
  });

  it('removes profit fields at any depth without pnl', () => {
    const payload = {
      projects: [{ name: 'A', net: 5, nested: { margin: 0.2, spent: 3 } }],
      profit: 9,
    };
    expect(stripPnl(actor('manager'), payload)).toEqual({
      projects: [{ name: 'A', nested: { spent: 3 } }],
    });
    expect(stripPnl(actor('owner'), payload)).toBe(payload);
  });
});
