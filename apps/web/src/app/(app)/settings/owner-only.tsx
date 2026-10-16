import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';

/** Owner-only settings pages check for themselves: the layout also admits the auditor (audit trail). */
export async function isOwner(): Promise<boolean> {
  const { actor } = await getSession();
  return actor.role === 'owner' && actor.active;
}

export function OwnerOnlyNotice() {
  return <EmptyState>This part of Users &amp; security is available to the owner only.</EmptyState>;
}
