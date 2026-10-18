import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Who am I + my rights: the UI uses this only to show or hide what the server already enforces. */
export const GET = api(async ({ actor }) => {
  const [me, company] = await Promise.all([
    services().users.me(actor),
    services().settings.companyInfo(actor),
  ]);
  return {
    id: actor.userId,
    ...me,
    role: actor.role,
    rights: actor.rights,
    projects: actor.projects,
    company,
  };
});
