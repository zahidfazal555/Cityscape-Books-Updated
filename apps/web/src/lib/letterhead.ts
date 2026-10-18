import 'server-only';
import type { Actor } from '@csd/core';
import type { Letterhead } from '@csd/services';
import { services } from './server';

/**
 * The header for a printed report or payslip. The full letterhead (address, bank) is readable by
 * anyone with a sales document right; others (e.g. payroll only) get the company name and GSTIN,
 * which every signed-in user may see.
 */
export async function printHeader(actor: Actor): Promise<Letterhead> {
  // Only "no sales right" falls back; any other failure (database, timeout) is an error.
  const full = await services()
    .settings.letterhead(actor)
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === 'FORBIDDEN') return null;
      throw e;
    });
  if (full) return full;
  const c = await services().settings.companyInfo(actor);
  return {
    name: c.name,
    legalName: null,
    gstin: c.gstin,
    stateCode: c.stateCode,
    address: null,
    phone: null,
    email: null,
    bankName: null,
    bankAccount: null,
    bankIfsc: null,
    bankBranch: null,
  };
}
