import { getSession } from '@/lib/session';
import { OwnerOnlyNotice, isOwner } from '../owner-only';
import { services } from '@/lib/server';
import { LockDateForm } from './lock-date-form';

const POLICY = [
  [
    'Sign-in',
    'Work email + password (min 12 characters, checked against known breaches). No SMS or one-time codes.',
  ],
  ['Lockout', '5 failed attempts pause sign-in for 15 minutes; you are notified.'],
  [
    'Sessions',
    'End after 30 minutes idle and after 7 days at most. Changing a password signs out everywhere.',
  ],
  [
    'New sign-in alerts',
    'You are notified when the Owner or Admin account signs in from a new device or address.',
  ],
  [
    'Audit trail',
    'Every create, edit, approval, payment, sign-in, export and rights change is recorded and cannot be edited.',
  ],
] as const;

export default async function SecurityPage() {
  if (!(await isOwner())) return <OwnerOnlyNotice />;
  const { actor } = await getSession();
  const settings = await services().settings.get(actor);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-lg border border-line bg-white p-4">
        <h2 className="mb-1 text-[15px] font-semibold">Books lock date</h2>
        <p className="mb-4 text-[13px] text-muted">
          Nothing dated on or before this date can be created, edited or deleted, by anyone. Set it
          to the month end after GST is filed.
        </p>
        <LockDateForm current={settings.lockDate} />
      </section>
      <section className="rounded-lg border border-line bg-white p-4">
        <h2 className="mb-3 text-[15px] font-semibold">Security policy</h2>
        <dl className="divide-y divide-divider text-[13px]">
          {POLICY.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[140px_1fr] gap-3 py-2">
              <dt className="font-medium">{k}</dt>
              <dd className="text-body">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
