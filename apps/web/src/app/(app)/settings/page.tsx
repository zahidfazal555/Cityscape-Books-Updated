import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function SettingsIndex() {
  const { actor } = await getSession();
  redirect(actor.role === 'owner' ? '/settings/users' : '/settings/audit');
}
