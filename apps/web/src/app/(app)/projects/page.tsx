import { can } from '@csd/core';
import type { ProjectStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ProjectsList } from './projects-list';

const FILTERS = ['all', 'active', 'on_hold', 'completed', 'cancelled'] as const;

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'projects', 'view'))
    return <EmptyState>You do not have access to projects.</EmptyState>;
  const raw = (await searchParams).status;
  const status =
    FILTERS.includes(raw as (typeof FILTERS)[number]) && raw !== 'all'
      ? (raw as ProjectStatus)
      : undefined;
  const canEdit = can(actor, 'projects', 'edit');
  const [projects, clients, team] = await Promise.all([
    services().projects.list(actor, status),
    canEdit && can(actor, 'contacts', 'view')
      ? services().contacts.list(actor, 'client')
      : Promise.resolve([]),
    canEdit ? services().users.team(actor) : Promise.resolve([]),
  ]);
  return (
    <ProjectsList
      projects={projects}
      filter={status ?? 'all'}
      canEdit={canEdit}
      clients={clients.map((c) => ({ id: c.id, name: c.name, stateCode: c.stateCode }))}
      team={team}
    />
  );
}
