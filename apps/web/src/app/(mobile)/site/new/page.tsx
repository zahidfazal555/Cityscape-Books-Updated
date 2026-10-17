import Link from 'next/link';
import { can } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { projectOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { NewSiteExpense } from './new-site-expense';

export default async function NewSiteExpensePage() {
  const { actor } = await getSession();
  if (!can(actor, 'expenses', 'edit')) return <EmptyState>You cannot add expenses.</EmptyState>;
  const sites = await projectOptions(actor);
  return (
    <div className="flex flex-col gap-4">
      <Link href="/site" className="text-[14px] text-muted">
        ← Back
      </Link>
      <h1 className="text-[20px] font-semibold">Add site expense</h1>
      <NewSiteExpense sites={sites} isOwner={actor.role === 'owner'} />
    </div>
  );
}
