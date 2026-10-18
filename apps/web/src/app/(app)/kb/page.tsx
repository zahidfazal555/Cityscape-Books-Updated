import { can } from '@csd/core';
import { PageHeader } from '@/components/kit';
import { LinkTabs } from '@/components/accounts/tabs';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { KbView } from './kb-view';

/** README §18 Knowledge base: care guides and reply templates (FR-21). */
export default async function KbPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'kb', 'view'))
    return <EmptyState>You do not have access to the knowledge base.</EmptyState>;
  const tab = (await searchParams).tab === 'templates' ? 'templates' : 'guides';
  const s = services();
  const [articles, templates] = await Promise.all([s.kb.articles(actor), s.kb.templates(actor)]);
  return (
    <>
      <PageHeader
        title="Knowledge base"
        subtitle="Care guides and reply templates, both insertable into ticket replies."
      />
      <LinkTabs
        value={tab}
        items={[
          { value: 'guides', label: 'Care guides', href: '/kb' },
          { value: 'templates', label: 'Reply templates', href: '/kb?tab=templates' },
        ]}
      />
      <KbView
        tab={tab}
        articles={articles}
        templates={templates}
        rights={{ edit: can(actor, 'kb', 'edit'), full: can(actor, 'kb', 'full') }}
      />
    </>
  );
}
