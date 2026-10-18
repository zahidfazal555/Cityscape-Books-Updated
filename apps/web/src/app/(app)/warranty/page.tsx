import { can } from '@csd/core';
import { PageHeader } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { WarrantyView } from './warranty-view';

/** README §18 Warranty register (FR-20). */
export default async function WarrantyPage() {
  const { actor } = await getSession();
  if (!can(actor, 'warranty', 'view'))
    return <EmptyState>You do not have access to the warranty register.</EmptyState>;
  const rows = await services().warranty.register(actor);
  return (
    <>
      <PageHeader
        title="Warranty register"
        subtitle="One warranty per project, from handover. Recording a handover completes the project."
      />
      <WarrantyView rows={rows} canEdit={can(actor, 'warranty', 'edit')} />
    </>
  );
}
