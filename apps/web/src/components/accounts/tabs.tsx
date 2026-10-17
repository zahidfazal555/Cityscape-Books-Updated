import Link from 'next/link';

/** Link tabs: the choice is in the URL, so it survives reloads and can be shared. */
export function LinkTabs({
  items,
  value,
}: {
  items: readonly { value: string; label: string; href: string }[];
  value: string;
}) {
  return (
    <nav
      data-noprint
      aria-label="Sections"
      className="mb-4 flex flex-wrap gap-1 border-b border-line"
    >
      {items.map((t) => (
        <Link
          key={t.value}
          href={t.href}
          aria-current={t.value === value ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] ${
            t.value === value
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted hover:text-body'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** A small "Export CSV" / download link styled as a ghost button. */
export function DownloadLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      data-noprint
      className="inline-flex h-9 items-center rounded-md border border-input bg-white px-4 text-[13.5px] font-medium text-primary hover:bg-thead"
    >
      {children}
    </a>
  );
}
