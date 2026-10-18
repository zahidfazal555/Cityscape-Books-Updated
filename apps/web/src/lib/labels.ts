import type { Module, Role } from '@csd/core';

/** Requirements §2.3 row labels, in display order. */
export const MODULE_LABEL: Record<Module, string> = {
  dashboard: 'Dashboard',
  projects: 'Projects & ledger',
  contacts: 'Clients & vendors',
  quotes: 'Quotations',
  proformas: 'Proforma invoices',
  invoices: 'Tax invoices & credit notes',
  receipts: 'Client receipts & advances',
  pos: 'Purchase orders',
  bills: 'Purchase bills & vendor payments',
  expenses: 'Expenses',
  approvals: 'Approve expenses',
  pnl: 'Profit, margins & net value',
  banking: 'Cash, bank & UPI',
  outstanding: 'Outstanding',
  gst: 'GST returns',
  reports: 'Reports',
  payroll: 'Payroll',
  inventory: 'Inventory',
  tickets: 'Support tickets & visits',
  warranty: 'Warranty register',
  kb: 'Knowledge base & templates',
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin · Accounts',
  manager: 'Project Manager',
  asstmgr: 'Asst. Manager · Project Management',
  site: 'Site Engineer',
  auditor: 'Auditor',
};

export const LEVEL_LABEL = { none: 'None', view: 'View', edit: 'Edit', full: 'Full' } as const;
