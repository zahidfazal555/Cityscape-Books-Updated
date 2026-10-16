import { istDate } from '@/lib/format';
import { getSession } from '@/lib/session';
import { OwnerOnlyNotice, isOwner } from '../owner-only';
import { services } from '@/lib/server';
import { UsersAdmin } from './users-admin';

export default async function UsersPage() {
  if (!(await isOwner())) return <OwnerOnlyNotice />;
  const { actor } = await getSession();
  const [users, projects] = await Promise.all([
    services().users.list(actor),
    services().projects.list(actor),
  ]);
  return (
    <UsersAdmin
      users={users.map((u) => ({
        ...u,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        accessExpiresAt: u.accessExpiresAt ? istDate(u.accessExpiresAt) : null,
      }))}
      projects={projects.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
    />
  );
}
