import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import { istHour, rupees } from '@/lib/format';
import { projectOptions } from '@/lib/purchase-options';
import { APPROVAL_STATUS } from '@/lib/purchases';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

/** Site engineer home (README §17): add expense, assigned sites, own entries. */
export default async function SiteHome() {
  const { actor, name } = await getSession();
  const hour = istHour();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const canAdd = can(actor, 'expenses', 'edit');
  const [sites, list] = await Promise.all([
    projectOptions(actor),
    can(actor, 'expenses', 'view') ? services().expenses.list(actor) : Promise.resolve(null),
  ]);
  const mine = (list?.rows ?? []).filter((e) => e.createdBy === actor.userId).slice(0, 30);
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[20px] font-semibold">
        {greeting}, {name.split(' ')[0]}
      </h1>
      {canAdd ? (
        <Link
          href="/site/new"
          className="flex h-14 items-center justify-center rounded-lg bg-primary text-[16px] font-semibold text-white"
        >
          + Add site expense
        </Link>
      ) : null}
      <section>
        <h2 className="mb-2 text-[14px] font-semibold">Your sites</h2>
        {sites.length === 0 ? <EmptyState>No sites assigned yet.</EmptyState> : null}
        <ul className="flex flex-col gap-2">
          {sites.map((s) => (
            <li
              key={s.id}
              className="min-h-[44px] rounded-lg border border-line bg-white px-3 py-2 text-[14px]"
            >
              <span className="font-mono text-[12px] text-muted">{s.code}</span> · {s.name}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-[14px] font-semibold">Your entries</h2>
        {mine.length === 0 ? <EmptyState>Nothing entered yet.</EmptyState> : null}
        <ul className="flex flex-col gap-2">
          {mine.map((e) => (
            <li
              key={e.id}
              className="flex min-h-[56px] items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px]">{e.particulars}</span>
                <span className="block text-xs text-muted">
                  {e.projectCode} · {formatDate(e.txnDate)}
                  {e.status === 'rejected' && e.rejectReason ? ` · ${e.rejectReason}` : ''}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="num text-[14px] font-semibold">{rupees(e.amount)}</span>
                <Pill tone={APPROVAL_STATUS[e.status].tone}>{APPROVAL_STATUS[e.status].label}</Pill>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
