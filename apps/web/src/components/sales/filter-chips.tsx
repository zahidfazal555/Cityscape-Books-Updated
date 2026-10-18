import Link from 'next/link';

/** Status filter chips as links, so the filter is in the URL and survives a reload. */
export function FilterChips({
  base,
  options,
  value,
}: {
  base: string;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <div
      data-noprint
      className="mb-3 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Filter by status"
    >
      {options.map(([v, label]) => (
        <Link
          key={v}
          href={v === 'all' ? base : `${base}?status=${v}`}
          aria-current={value === v ? 'true' : undefined}
          className={`h-[30px] rounded-[15px] border px-3 text-[13px] leading-[28px] ${
            value === v
              ? 'border-primary bg-primary-tint font-medium text-primary'
              : 'border-input bg-white text-body'
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

/** Summary cards above a list. */
export function Cards({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <dl className="mb-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="bg-white p-3">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="num text-[18px] font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
