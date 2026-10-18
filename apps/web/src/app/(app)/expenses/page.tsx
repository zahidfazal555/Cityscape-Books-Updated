import { COST_CATEGORIES, can, type CostCategory } from '@csd/core';
import { EXPENSE_STATUSES, type ExpenseStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { projectOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ExpensesView } from './expenses-view';

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; category?: string; status?: string }>;
}) {
  const { actor, company } = await getSession();
  if (!can(actor, 'expenses', 'view'))
    return <EmptyState>You do not have access to expenses.</EmptyState>;
  const q = await searchParams;
  const [projects, forms] = await Promise.all([
    projectOptions(actor, 'filter'),
    projectOptions(actor, 'spend'),
  ]);
  const filter = {
    projectId: projects.find((p) => p.id === q.projectId)?.id,
    category: COST_CATEGORIES.find((c) => c === q.category) as CostCategory | undefined,
    status: EXPENSE_STATUSES.find((s) => s === q.status) as ExpenseStatus | undefined,
  };
  const list = await services().expenses.list(actor, filter);
  return (
    <ExpensesView
      list={list}
      filter={filter}
      projects={projects}
      formProjects={forms}
      lockDate={company.lockDate}
      me={actor.userId}
      rights={{
        edit: can(actor, 'expenses', 'edit'),
        full: can(actor, 'expenses', 'full'),
        owner: actor.role === 'owner',
      }}
    />
  );
}
