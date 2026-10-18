import { can } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { projectOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { InventoryView } from './inventory-view';

/** README §15 Inventory: material purchases per project (FR-18). */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'inventory', 'view'))
    return <EmptyState>You do not have access to inventory.</EmptyState>;
  const [projects, forms] = await Promise.all([
    projectOptions(actor, 'filter'),
    projectOptions(actor, 'spend'),
  ]);
  const raw = (await searchParams).projectId;
  const projectId = projects.find((p) => p.id === raw)?.id;
  const view = await services().inventory.list(actor, { projectId });
  return (
    <InventoryView
      view={view}
      projectId={projectId ?? null}
      projects={projects}
      formProjects={forms}
      me={actor.userId}
      rights={{ edit: can(actor, 'inventory', 'edit'), full: can(actor, 'inventory', 'full') }}
    />
  );
}
