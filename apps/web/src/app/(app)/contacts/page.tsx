import { can } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ContactsView } from './contacts-view';

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'contacts', 'view'))
    return <EmptyState>You do not have access to clients and vendors.</EmptyState>;
  const sp = await searchParams;
  const type = sp.tab === 'vendor' ? 'vendor' : 'client';
  const q = (sp.q ?? '').slice(0, 100);
  const contacts = await services().contacts.list(actor, type, q);
  return (
    <ContactsView
      type={type}
      q={q}
      contacts={contacts}
      canEdit={can(actor, 'contacts', 'edit')}
      canArchive={can(actor, 'contacts', 'full')}
    />
  );
}
