'use client';

import { useState } from 'react';
import type { Paise } from '@csd/core';
import { rupees } from '@/lib/format';

const INVOICED = '#2a78d6';
const SPENT = '#eb6834';
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' });
const label = (ym: string) => MONTH.format(new Date(`${ym}-01T00:00:00Z`));

const W = 320;
const H = 210;
const BASE = H - 20;
const BAR = 12;

/** Round the axis top up to 1, 2 or 5 × a power of ten, so gridlines land on plain numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/**
 * Invoiced vs spent per month (two series, one axis): grouped columns with a 2px gap, rounded
 * data ends on the baseline, a legend, and a hover tooltip per month.
 */
export function TrendBars({
  months,
}: {
  months: { month: string; invoiced: Paise; spent: Paise }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(...months.flatMap((m) => [m.invoiced, m.spent])));
  const any = months.some((m) => m.invoiced !== 0 || m.spent !== 0);
  const slot = W / months.length;
  const y = (v: Paise) => BASE - (Math.max(0, v) / top) * (BASE - 8);
  const h = hover === null ? null : months[hover];
  return (
    <section className="flex flex-col rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Last 6 months</h2>
        <ul className="flex gap-3 text-[12px] text-muted">
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: INVOICED }} />
            Invoiced (excl. GST)
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: SPENT }} />
            Spent
          </li>
        </ul>
      </div>
      {!any ? (
        <p className="flex flex-1 items-center justify-center py-10 text-[13px] text-muted">
          Nothing invoiced or spent in the last six months.
        </p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label={months
              .map(
                (m) =>
                  `${label(m.month)}: invoiced ${rupees(m.invoiced)}, spent ${rupees(m.spent)}`,
              )
              .join('; ')}
          >
            {[0.5, 1].map((f) => (
              <line key={f} x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="#eef1f5" />
            ))}
            <line x1={0} x2={W} y1={BASE} y2={BASE} stroke="#e3e7ed" />
            {months.map((m, i) => {
              const cx = slot * i + slot / 2;
              return (
                <g
                  key={m.month}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  opacity={hover !== null && hover !== i ? 0.45 : 1}
                >
                  {/* The hit target is the whole month column, bigger than the bars. */}
                  <rect x={slot * i} y={0} width={slot} height={H} fill="transparent" />
                  <rect
                    x={cx - BAR - 1}
                    y={y(m.invoiced)}
                    width={BAR}
                    height={BASE - y(m.invoiced)}
                    rx={3}
                    fill={INVOICED}
                  />
                  <rect
                    x={cx + 1}
                    y={y(m.spent)}
                    width={BAR}
                    height={BASE - y(m.spent)}
                    rx={3}
                    fill={SPENT}
                  />
                  <text x={cx} y={H - 5} textAnchor="middle" fontSize={10} fill="#5b6573">
                    {label(m.month)}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="pointer-events-none absolute right-0 top-0 text-right text-[11px] text-muted">
            {rupees(top)}
          </div>
          {h ? (
            <div className="pointer-events-none absolute left-2 top-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-[12px] shadow-sm">
              <div className="font-medium text-ink">{label(h.month)}</div>
              <div className="num text-ink">
                {rupees(h.invoiced)} <span className="text-muted">invoiced</span>
              </div>
              <div className="num text-ink">
                {rupees(h.spent)} <span className="text-muted">spent</span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
