import type { ReactNode } from 'react';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { SettingsTabs } from './tabs';

const TABS = [
  { href: '/settings/users', label: 'Users & access', ownerOnly: true },
  { href: '/settings/roles', label: 'Role templates', ownerOnly: true },
  { href: '/settings/security', label: 'Security', ownerOnly: true },
  { href: '/settings/audit', label: 'Audit trail', ownerOnly: false },
];

/** Users & security (Req §16): owner only; the auditor may open the audit trail. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { actor } = await getSession();
  const owner = actor.role === 'owner';
  if (!owner && actor.role !== 'auditor') {
    return <EmptyState>Users &amp; security is available to the owner only.</EmptyState>;
  }
  return (
    <div>
      <h1 className="mb-1 text-[22px] font-semibold">Users &amp; security</h1>
      <p className="mb-4 text-[13px] text-muted">
        Who can sign in, what each person can do, the books lock date and the audit trail.
      </p>
      <SettingsTabs tabs={TABS.filter((t) => owner || !t.ownerOnly)} />
      {children}
    </div>
  );
}
