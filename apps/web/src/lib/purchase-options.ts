import 'server-only';
import { can, type Actor } from '@csd/core';
import type { ProjectStatus } from '@csd/services';
import type { VendorOption } from '@/components/purchases/bill-drawer';
import type { ProjectOption } from '@/components/sales/use-action';
import { services } from './server';

/** Vendors for purchase forms (needs contacts view). */
export async function vendorOptions(actor: Actor): Promise<VendorOption[]> {
  if (!can(actor, 'contacts', 'view')) return [];
  const vendors = await services().contacts.list(actor, 'vendor');
  return vendors
    .map((v) => ({ id: v.id, name: v.name, gstin: v.gstin, stateCode: v.stateCode }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ProjectUse = 'spend' | 'bill' | 'filter';

/**
 * Projects for a form or filter, matching what the server accepts (BUG-114): new spends and POs
 * on active or on-hold projects; bills also on completed ones; filters on every project.
 */
export async function projectOptions(
  actor: Actor,
  use: ProjectUse = 'spend',
): Promise<ProjectOption[]> {
  if (!can(actor, 'projects', 'view')) return [];
  const allowed: Record<ProjectUse, readonly ProjectStatus[]> = {
    spend: ['active', 'on_hold'],
    bill: ['active', 'on_hold', 'completed'],
    filter: ['active', 'on_hold', 'completed', 'cancelled'],
  };
  const list = await services().projects.list(actor);
  return list
    .filter((p) => allowed[use].includes(p.status))
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      clientName: p.clientName,
      clientStateCode: p.clientStateCode,
    }));
}
