import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { AuditTable } from './audit-table';

export default async function AuditPage() {
  const { actor } = await getSession();
  const rows = await services().audit.list(actor, { limit: 50 });
  return <AuditTable initial={rows.map((r) => ({ ...r, at: r.at.toISOString() }))} />;
}
