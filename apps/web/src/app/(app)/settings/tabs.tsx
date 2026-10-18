'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="mb-5 flex gap-1 border-b border-line">
      {tabs.map((t) => {
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 pb-2 text-[13.5px] ${
              active
                ? 'border-primary font-semibold text-primary'
                : 'border-transparent text-body hover:text-primary'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
