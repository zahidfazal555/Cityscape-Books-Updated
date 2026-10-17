import { canApprove } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ApprovalsView } from './approvals-view';

/** README §9: the Owner's approval queue (H2). */
export default async function ApprovalsPage() {
  const { actor } = await getSession();
  if (!canApprove(actor)) return <EmptyState>Only the owner approves entries.</EmptyState>;
  const queue = await services().approvals.queue(actor);
  return <ApprovalsView queue={queue} />;
}
