import Link from 'next/link';
import { formatDate, type Actor, type IsoDate } from '@csd/core';
import { navFor } from '@/lib/nav';

/** Left navigation: only modules the user can view; "Books locked till" box at the bottom (README). */
export function SideNav({ actor, lockDate }: { actor: Actor; lockDate: IsoDate | null }) {
  return (
    <nav
      aria-label="Main"
      className="sticky top-14 flex h-[calc(100vh-56px)] w-[220px] shrink-0 flex-col overflow-y-auto border-r border-line bg-white px-3 py-4"
    >
      {navFor(actor).map((group) => (
        <div key={group.label ?? 'main'} className="mb-3">
          {group.label ? (
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[.06em] text-subtle">
              {group.label}
            </div>
          ) : null}
          {group.items.map((item) =>
            item.ready ? (
              <Link
                key={item.href}
                href={item.href}
                className="flex h-[34px] items-center rounded-md px-2 text-[13.5px] text-body hover:bg-thead"
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.href}
                className="flex h-[34px] items-center justify-between rounded-md px-2 text-[13.5px] text-subtle"
                aria-disabled
              >
                {item.label}
                <span className="rounded bg-track px-1.5 text-[10.5px]">Soon</span>
              </span>
            ),
          )}
        </div>
      ))}
      <div className="mt-auto rounded-md bg-app p-2.5 text-xs leading-snug text-muted">
        {lockDate ? (
          <>
            Books locked till <strong className="text-ink">{formatDate(lockDate)}</strong>. Earlier
            entries are read-only.
          </>
        ) : (
          'Books are not locked.'
        )}
      </div>
    </nav>
  );
}
