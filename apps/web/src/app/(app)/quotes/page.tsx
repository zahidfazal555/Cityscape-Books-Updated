import { can } from '@csd/core';
import type { QuoteStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { QuotesView } from './quotes-view';

const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'quotes', 'view'))
    return <EmptyState>You do not have access to quotations.</EmptyState>;
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw) as QuoteStatus | undefined;
  const canEdit = can(actor, 'quotes', 'edit');
  const [quotes, all, clients, letterhead] = await Promise.all([
    services().quotations.list(actor, { status }),
    // Cards and win rate are over every quote, whatever the filter.
    status ? services().quotations.list(actor) : Promise.resolve(null),
    canEdit && can(actor, 'contacts', 'view')
      ? services().contacts.list(actor, 'client')
      : Promise.resolve([]),
    services().settings.letterhead(actor),
  ]);
  return (
    <QuotesView
      quotes={quotes}
      all={all ?? quotes}
      filter={status ?? 'all'}
      canEdit={canEdit}
      clients={clients.map((c) => ({ id: c.id, name: c.name, stateCode: c.stateCode }))}
      companyStateCode={letterhead.stateCode}
    />
  );
}
