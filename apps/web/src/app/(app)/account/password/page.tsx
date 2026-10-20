import { ChangePasswordForm } from '@/components/change-password-form';
import { PageHeader } from '@/components/kit';
import { getSession } from '@/lib/session';

/** Change my password: every signed-in user, from the top bar. */
export default async function ChangeMyPasswordPage() {
  const { name } = await getSession();
  return (
    <div className="max-w-md">
      <PageHeader
        title="Change my password"
        subtitle={`Signed in as ${name}. Saving signs you out everywhere, including here; sign in again with the new password.`}
      />
      <section className="rounded-xl border border-line bg-white p-5">
        <ChangePasswordForm />
      </section>
    </div>
  );
}
