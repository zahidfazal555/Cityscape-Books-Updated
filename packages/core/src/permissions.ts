import { DomainError } from './errors.js';

export const LEVELS = ['none', 'view', 'edit', 'full'] as const;
export type Level = (typeof LEVELS)[number];

export const ROLES = ['owner', 'admin', 'manager', 'asstmgr', 'site', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

/** Requirements v1.3 §2.3 — the 21 rights modules, in display order. */
export const MODULES = [
  'dashboard',
  'projects',
  'contacts',
  'quotes',
  'proformas',
  'invoices',
  'receipts',
  'pos',
  'bills',
  'expenses',
  'approvals',
  'pnl',
  'banking',
  'outstanding',
  'gst',
  'reports',
  'payroll',
  'inventory',
  'tickets',
  'warranty',
  'kb',
] as const;
export type Module = (typeof MODULES)[number];

/** Some modules only allow a subset of levels (Tech Spec §5). */
export const ALLOWED_LEVELS: Readonly<Record<Module, readonly Level[]>> = Object.fromEntries(
  MODULES.map((m) => {
    if (m === 'dashboard' || m === 'outstanding' || m === 'reports' || m === 'pnl') {
      return [m, ['none', 'view']];
    }
    if (m === 'approvals') return [m, ['none', 'full']];
    return [m, LEVELS];
  }),
) as Record<Module, readonly Level[]>;

export type Rights = Readonly<Record<Module, Level>>;

const N = 'none',
  V = 'view',
  E = 'edit',
  F = 'full';
// prettier-ignore
const TEMPLATE_ROWS: Record<Module, [admin: Level, manager: Level, asstmgr: Level, site: Level, auditor: Level]> = {
  dashboard:   [V, V, V, N, V],
  projects:    [F, E, E, V, V],
  contacts:    [F, E, V, N, V],
  quotes:      [F, E, E, N, V],
  proformas:   [F, E, V, N, V],
  invoices:    [F, E, V, N, V],
  receipts:    [F, E, V, N, V],
  pos:         [F, E, E, N, V],
  bills:       [F, E, E, N, V],
  expenses:    [F, E, E, E, V],
  approvals:   [N, N, N, N, N],
  pnl:         [N, N, N, N, V],
  banking:     [F, N, N, N, V],
  outstanding: [V, V, V, N, V],
  gst:         [F, V, N, N, V],
  reports:     [V, V, V, N, V],
  payroll:     [F, N, N, N, V],
  inventory:   [F, E, E, V, V],
  tickets:     [V, V, F, N, N],
  warranty:    [V, V, E, N, N],
  kb:          [V, V, F, N, N],
};

const COLUMN: Record<Exclude<Role, 'owner'>, number> = {
  admin: 0,
  manager: 1,
  asstmgr: 2,
  site: 3,
  auditor: 4,
};

/** The rights a new user of this role starts with. The owner can then change any module. */
export function roleTemplate(role: Role): Rights {
  return Object.fromEntries(
    MODULES.map((m) => {
      if (role === 'owner') return [m, ALLOWED_LEVELS[m].at(-1)];
      return [m, TEMPLATE_ROWS[m][COLUMN[role]]];
    }),
  ) as Rights;
}

export interface Actor {
  userId: string;
  companyId: string;
  role: Role;
  rights: Rights;
  /** 'all' or the explicit list of project IDs this user may see. */
  projects: 'all' | readonly string[];
  active: boolean;
}

const rank = (level: Level): number => LEVELS.indexOf(level);

/**
 * The one permission check (ENGINEERING-STANDARDS §2). The owner always passes.
 * With `projectId`, the user's project scope is checked too.
 */
export function can(
  actor: Actor,
  module: Module,
  level: Level,
  projectId?: string | null,
): boolean {
  if (!actor.active) return false;
  if (actor.role === 'owner') return true;
  if (rank(actor.rights[module]) < rank(level)) return false;
  if (projectId != null && actor.projects !== 'all') return actor.projects.includes(projectId);
  return true;
}

/** Throws 403. Use in every handler; the UI only hides what this already refuses. */
export function authorize(
  actor: Actor,
  module: Module,
  level: Level,
  projectId?: string | null,
): void {
  if (!can(actor, module, level, projectId)) {
    throw new DomainError('FORBIDDEN', 'You do not have access to this.');
  }
}

/** Returns the project filter for list queries: null = no filter (all projects). */
export function projectScope(actor: Actor): readonly string[] | null {
  return actor.role === 'owner' || actor.projects === 'all' ? null : actor.projects;
}

/**
 * Validates a rights map an owner is saving for a user: every module present and every
 * level allowed for that module. Users & security is not a module and cannot be granted.
 */
export function validateRights(input: Record<string, string>): Rights {
  const out: Partial<Record<Module, Level>> = {};
  for (const m of MODULES) {
    const level = input[m] as Level | undefined;
    if (level === undefined || !ALLOWED_LEVELS[m].includes(level)) {
      throw new DomainError(
        'VALIDATION',
        `Choose a valid access level for ${m}.`,
        `permissions.${m}`,
      );
    }
    out[m] = level;
  }
  const unknown = Object.keys(input).filter((k) => !(MODULES as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new DomainError('VALIDATION', `Unknown module: ${unknown.join(', ')}.`, 'permissions');
  }
  return out as Rights;
}

/** True when the user's rights differ from their role template ("Custom rights" badge). */
export function hasCustomRights(role: Role, rights: Rights): boolean {
  const template = roleTemplate(role);
  return MODULES.some((m) => template[m] !== rights[m]);
}

/**
 * ENGINEERING-STANDARDS H2: anything a user without `approvals = full` enters — expenses,
 * payments, payroll, rate changes, discounts — is saved Pending with no journal.
 */
export function requiresApproval(actor: Actor): boolean {
  return !can(actor, 'approvals', 'full');
}

const PNL_FIELDS = new Set(['profit', 'margin', 'net', 'netValue', 'profitSoFar', 'grossProfit']);

/**
 * Tech Spec §5: without `pnl`, profit/margin/net are removed from API responses, at any depth.
 */
export function stripPnl<T>(actor: Actor, value: T): T {
  if (can(actor, 'pnl', 'view')) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !PNL_FIELDS.has(k))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}
