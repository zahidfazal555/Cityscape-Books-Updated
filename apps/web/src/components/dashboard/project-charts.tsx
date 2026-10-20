import { CATEGORY_LABEL, COST_CATEGORIES, type Paise } from '@csd/core';
import type { ProjectCharts as Charts } from '@csd/services';
import { rupees } from '@/lib/format';
import { CATEGORY_SLOT, OTHER } from './dashboard-view';
import { Donut, type DonutSlice } from './donut';
import { TrendBars } from './trend-bars';

const pctOf = (part: Paise, whole: Paise) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * A ratio against a limit (dataviz: a meter, not a two-slice pie). Over 100% the fill stops at the
 * track's end and the label says so; the tone, when given, comes with words, never colour alone.
 */
function Meter({
  label,
  part,
  whole,
  note,
  tone = 'bg-[#2a78d6]',
}: {
  label: string;
  part: Paise;
  whole: Paise;
  note: string;
  tone?: string;
}) {
  const p = pctOf(part, whole);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-body">{label}</span>
        <span className="num text-ink">
          {whole > 0 ? `${Math.floor(p)}%` : '—'}
          {p > 100 ? <span className="ml-1 text-danger">over</span> : null}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-track">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
      <div className="num text-[12px] text-muted">{note}</div>
    </div>
  );
}

/** Budget tone uses the status colours with a word beside it (on track / near / over budget). */
function budgetTone(spent: Paise, budget: Paise): { tone: string; word: string } {
  const p = pctOf(spent, budget);
  if (budget <= 0) return { tone: 'bg-[#8a94a6]', word: 'no budget set' };
  if (p > 100) return { tone: 'bg-[#d03b3b]', word: 'over budget' };
  if (p >= 80) return { tone: 'bg-[#fab219]', word: 'near the budget' };
  return { tone: 'bg-[#0ca30c]', word: 'on track' };
}

/** Project page charts: where this project's money goes, budget and billing, and the trend. */
export function ProjectCharts({ projectId, d }: { projectId: string; d: Charts }) {
  const main = COST_CATEGORIES.filter((c) => CATEGORY_SLOT[c]);
  const other = COST_CATEGORIES.filter((c) => !CATEGORY_SLOT[c]).reduce(
    (n, c) => n + Math.max(0, d.spendByCategory[c]),
    0,
  );
  const slices: DonutSlice[] = [
    ...main.map((c) => ({
      key: c,
      label: CATEGORY_LABEL[c],
      amount: Math.max(0, d.spendByCategory[c]),
      colour: CATEGORY_SLOT[c] ?? OTHER,
      href: `/spend/${c}?project=${projectId}`,
    })),
    {
      key: 'other',
      label: 'Other categories',
      amount: other,
      colour: OTHER,
      href: `/spend/other?project=${projectId}`,
    },
  ];
  const budget = budgetTone(d.spent, d.costBudget);
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
      <Donut
        title="Spend by category"
        slices={slices}
        totalLabel="Spent on this project"
        empty="No approved spending on this project yet."
      />
      <section className="flex flex-col gap-4 rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <h2 className="text-[15px] font-semibold">Budget &amp; billing</h2>
        <Meter
          label="Cost budget used"
          part={d.spent}
          whole={d.costBudget}
          tone={budget.tone}
          note={`${rupees(d.spent)} of ${rupees(d.costBudget)} · ${budget.word}`}
        />
        {d.billing ? (
          <>
            <Meter
              label="Contract billed"
              part={d.billing.invoicedTaxable}
              whole={d.contractValue}
              note={`${rupees(d.billing.invoicedTaxable)} invoiced of ${rupees(d.contractValue)} (excl. GST)`}
            />
            <Meter
              label="Invoices collected"
              part={d.billing.received}
              whole={d.billing.invoicedTotal}
              tone="bg-[#1baf7a]"
              note={`${rupees(d.billing.received)} received of ${rupees(d.billing.invoicedTotal)} invoiced (incl. GST)`}
            />
          </>
        ) : null}
      </section>
      <TrendBars months={d.months} />
    </div>
  );
}
