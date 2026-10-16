import { withTenant } from '@csd/db';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Who am I + my rights: the UI uses this only to show or hide things the server already enforces. */
export const GET = api(async ({ actor }) => {
  const { name, email } = await withTenant(services().pool, actor, async (c) => {
    const { rows } = await c.query<{ name: string; email: string }>(
      'SELECT name, email FROM app_user WHERE id = $1',
      [actor.userId],
    );
    return rows[0] ?? { name: '', email: '' };
  });
  const settings = await services().settings.get(actor);
  return {
    id: actor.userId,
    name,
    email,
    role: actor.role,
    rights: actor.rights,
    projects: actor.projects,
    company: { name: settings.name, lockDate: settings.lockDate },
  };
});
