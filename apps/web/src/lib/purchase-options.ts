import 'server-only';
import { can, type Actor } from '@csd/core';
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

/** Open projects the user can see. */
export async function projectOptions(actor: Actor): Promise<ProjectOption[]> {
  if (!can(actor, 'projects', 'view')) return [];
  const list = await services().projects.list(actor, 'active');
  return list.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    clientName: p.clientName,
    clientStateCode: p.clientStateCode,
  }));
}
