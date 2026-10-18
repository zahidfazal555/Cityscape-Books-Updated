import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { OwnerOnlyNotice, isOwner } from '../owner-only';
import { CompanyForm } from './company-form';

/** GO-LIVE §6 step 3: the details printed on every quotation, invoice, receipt, PO and bill. */
export default async function CompanyPage() {
  if (!(await isOwner())) return <OwnerOnlyNotice />;
  const { actor } = await getSession();
  const profile = await services().settings.profile(actor);
  return (
    <section className="max-w-3xl rounded-lg border border-line bg-white p-4">
      <h2 className="mb-1 text-[15px] font-semibold">Company details</h2>
      <p className="mb-4 text-[13px] text-muted">
        Printed on quotations, proformas, invoices, receipts, purchase orders and bills. Changes
        apply to every document from now on, including reprints.
      </p>
      <CompanyForm current={profile} />
    </section>
  );
}
