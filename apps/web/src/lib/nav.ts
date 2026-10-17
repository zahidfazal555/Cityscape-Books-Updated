import { can, canApprove, type Actor, type Module } from '@csd/core';

export interface NavItem {
  label: string;
  href: string;
  /** Rights module that must be at least `view`; `owner` = Users & security (not grantable); `auditTrail` = owner or auditor. */
  module: Module | 'owner' | 'auditTrail';
  /** Built in this release; others show as "Soon". */
  ready: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/** Left navigation (Req FR-3.4.1). Items the user has no right to are not listed at all. */
const GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { label: 'Dashboard', href: '/', module: 'dashboard', ready: true },
      { label: 'Projects', href: '/projects', module: 'projects', ready: true },
      { label: 'Clients & vendors', href: '/contacts', module: 'contacts', ready: true },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Quotations', href: '/quotes', module: 'quotes', ready: true },
      { label: 'Proforma invoices', href: '/proformas', module: 'proformas', ready: true },
      { label: 'Tax invoices', href: '/invoices', module: 'invoices', ready: true },
      { label: 'Client receipts', href: '/receipts', module: 'receipts', ready: true },
    ],
  },
  {
    label: 'Purchases',
    items: [
      { label: 'Purchase orders', href: '/purchase-orders', module: 'pos', ready: true },
      { label: 'Purchase bills', href: '/bills', module: 'bills', ready: true },
      { label: 'Expenses', href: '/expenses', module: 'expenses', ready: true },
      { label: 'Approvals', href: '/approvals', module: 'approvals', ready: true },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { label: 'Cash, bank & UPI', href: '/banking', module: 'banking', ready: false },
      { label: 'Outstanding', href: '/outstanding', module: 'outstanding', ready: false },
      { label: 'GST returns', href: '/gst', module: 'gst', ready: false },
      { label: 'Reports', href: '/reports', module: 'reports', ready: false },
    ],
  },
  {
    label: 'Support',
    items: [
      { label: 'Tickets', href: '/tickets', module: 'tickets', ready: false },
      { label: 'Warranty register', href: '/warranty', module: 'warranty', ready: false },
      { label: 'Knowledge base', href: '/kb', module: 'kb', ready: false },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Payroll', href: '/payroll', module: 'payroll', ready: false },
      { label: 'Inventory', href: '/inventory', module: 'inventory', ready: false },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Users & security', href: '/settings/users', module: 'owner', ready: true },
      { label: 'Audit trail', href: '/settings/audit', module: 'auditTrail', ready: true },
    ],
  },
];

export function navFor(actor: Actor): NavGroup[] {
  const visible = (i: NavItem): boolean => {
    if (i.module === 'owner') return actor.role === 'owner';
    // The owner reaches the audit trail from Users & security; the auditor gets its own entry.
    if (i.module === 'auditTrail') return actor.role === 'auditor';
    // H2: only the Owner approves, whatever rights others are given (BUG-115).
    if (i.module === 'approvals') return canApprove(actor);
    return can(actor, i.module, 'view');
  };
  return GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter(
    (g) => g.items.length > 0,
  );
}
