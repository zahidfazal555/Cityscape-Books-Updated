'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Paise } from '@csd/core';
import { rupees } from '@/lib/format';

export interface DonutSlice {
  key: string;
  label: string;
  amount: Paise;
  colour: string;
  /** Where the slice opens to: its detail page (a click on the segment or the legend row). */
  href?: string;
}

const SIZE = 168;
const STROKE = 26;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;
/** The 2px surface gap between segments (dataviz marks spec), as arc length. */
const GAP = 2;

const pct = (part: number, total: number) =>
  total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`;

/**
 * A donut for part-to-whole at a glance (≤ 6 segments). Hover or focus a segment or its legend row
 * and the centre shows that slice; the legend always lists every value, so identity is never
 * colour alone and the numbers are readable without hovering. A slice with `href` opens its
 * detail on click; the legend row is a real link, so keyboard and screen readers reach it too.
 */
export function Donut({
  title,
  slices,
  totalLabel = 'Total',
  empty,
}: {
  title: string;
  slices: DonutSlice[];
  totalLabel?: string;
  empty: string;
}) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(null);
  const shown = slices.filter((s) => s.amount > 0);
  const total = shown.reduce((n, s) => n + s.amount, 0);
  const hit = shown.find((s) => s.key === active) ?? null;
  let offset = 0;
  return (
    <section className="flex flex-col rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
      {total === 0 ? (
        <p className="flex flex-1 items-center justify-center py-10 text-[13px] text-muted">
          {empty}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
            <svg
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              width={SIZE}
              height={SIZE}
              role="img"
              aria-label={`${title}: ${shown.map((s) => `${s.label} ${rupees(s.amount)}`).join(', ')}`}
              className="-rotate-90"
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                fill="none"
                stroke="#f1f4f8"
                strokeWidth={STROKE}
              />
              {shown.map((s) => {
                const len = (s.amount / total) * C;
                const dash = shown.length > 1 ? Math.max(len - GAP, 0.5) : len;
                const el = (
                  <circle
                    key={s.key}
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={R}
                    fill="none"
                    stroke={s.colour}
                    strokeWidth={active === s.key ? STROKE + 6 : STROKE}
                    strokeDasharray={`${dash} ${C - dash}`}
                    strokeDashoffset={-offset}
                    opacity={active && active !== s.key ? 0.3 : 1}
                    className={`transition-[opacity,stroke-width] duration-150 ${s.href ? 'cursor-pointer' : ''}`}
                    onMouseEnter={() => setActive(s.key)}
                    onMouseLeave={() => setActive(null)}
                    onClick={s.href ? () => router.push(s.href ?? '/') : undefined}
                  />
                );
                offset += len;
                return el;
              })}
            </svg>
            <div
              aria-live="polite"
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center"
            >
              <span className="num text-[15px] font-semibold leading-tight text-ink">
                {rupees(hit ? hit.amount : total)}
              </span>
              <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted">
                {hit ? `${hit.label} · ${pct(hit.amount, total)}` : totalLabel}
              </span>
            </div>
          </div>
          <ul className="flex min-w-[190px] flex-1 flex-col gap-1 text-[13px]">
            {shown.map((s) => {
              const row = {
                onMouseEnter: () => setActive(s.key),
                onMouseLeave: () => setActive(null),
                onFocus: () => setActive(s.key),
                onBlur: () => setActive(null),
                className: `group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
                  active === s.key ? 'bg-thead' : ''
                }`,
              };
              const body = (
                <>
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.colour }} />
                  <span className="min-w-0 flex-1 truncate text-body group-hover:text-primary">
                    {s.label}
                  </span>
                  <span className="num text-ink">{rupees(s.amount)}</span>
                  <span className="num w-9 text-right text-muted">{pct(s.amount, total)}</span>
                  {s.href ? (
                    <span aria-hidden className="w-3 text-subtle group-hover:text-primary">
                      ›
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={s.key}>
                  {s.href ? (
                    <Link href={s.href} {...row} title={`Open ${s.label}`}>
                      {body}
                    </Link>
                  ) : (
                    <button type="button" {...row}>
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
