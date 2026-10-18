import type { ReactNode } from 'react';
import { amountInWords, formatQty, type Paise } from '@csd/core';
import type { Letterhead } from '@csd/services';
import { placeOfSupply, type DocSection, type DocSpec } from '@/lib/documents';
import { rupees } from '@/lib/format';

const inr = (p: Paise) => rupees(p);

function Section({ s }: { s: DocSection }) {
  return (
    <div className="flex flex-col gap-1">
      {s.note ? <p className="text-xs text-muted">{s.note}</p> : null}
      {s.heading ? (
        <div
          className={`text-[11px] font-semibold uppercase tracking-[.05em] text-muted ${s.note ? 'mt-2' : ''}`}
        >
          {s.heading}
        </div>
      ) : null}
      {s.rows ? (
        s.rows.length === 0 ? (
          <p className="text-muted">{s.empty}</p>
        ) : (
          s.rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <span>{r.label}</span>
              <span className="num">{inr(r.amount)}</span>
            </div>
          ))
        )
      ) : null}
      {s.text ? (
        <p className={`whitespace-pre-line ${s.rows ? 'mt-2 text-muted' : ''}`}>{s.text}</p>
      ) : null}
    </div>
  );
}

/**
 * Printable A4 layout shared by quotation, proforma, tax invoice, credit note and purchase order
 * (README §5): letterhead, title and number, party, dates, lines, GST split, total in words, bank
 * details. `extra` is screen-only help under the sections.
 */
export function A4Document({
  spec,
  letterhead,
  extra,
}: {
  spec: DocSpec;
  letterhead: Letterhead;
  extra?: ReactNode;
}) {
  const { title, number, party, totals, watermark } = spec;
  const sections = spec.sections.filter((s) => s.text || s.note || s.rows);
  return (
    <article
      aria-label={`${title} ${number}`}
      className="relative mx-auto w-full max-w-[820px] overflow-hidden rounded-lg border border-line bg-white p-8 text-[13px] print:max-w-none print:border-0 print:p-0"
    >
      {watermark ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="-rotate-[24deg] whitespace-nowrap text-[64px] font-bold tracking-[.08em] text-danger opacity-[.12]">
            {watermark}
          </span>
        </div>
      ) : (
        // Final documents carry the company mark, very light (same as their PDF).
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <img src="/brand/cityscape-watermark.png" alt="" className="w-[320px] opacity-[.06]" />
        </div>
      )}
      {watermark ? (
        <p className="mb-3 rounded border border-danger-line bg-danger-bg px-3 py-1.5 text-center text-[12px] font-semibold text-danger">
          {watermark}
        </p>
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <img src="/brand/cityscape-logo.png" alt={letterhead.name} className="mb-2 h-8 w-auto" />
          <div className="font-semibold">{letterhead.legalName ?? letterhead.name}</div>
          {letterhead.address ? (
            <div className="whitespace-pre-line text-muted">{letterhead.address}</div>
          ) : null}
          <div className="text-muted">
            {letterhead.gstin ? `GSTIN ${letterhead.gstin}` : 'GSTIN not set'} ·{' '}
            {placeOfSupply(letterhead.stateCode)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[18px] font-semibold tracking-[.04em] text-heading">{title}</div>
          <div className="font-mono text-[13px]">{number}</div>
        </div>
      </header>
      <section className="grid grid-cols-1 gap-4 border-b border-line py-4 sm:grid-cols-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
            {spec.partyLabel}
          </div>
          <div className="font-medium">{party.name}</div>
          {party.address ? (
            <div className="whitespace-pre-line text-muted">{party.address}</div>
          ) : null}
          {party.gstin ? <div className="text-muted">GSTIN {party.gstin}</div> : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 sm:justify-self-end">
          {spec.meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-[.05em] text-muted">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-2">Description</th>
            <th className="py-2 pr-2">SAC/HSN</th>
            <th className="py-2 pr-2 text-right">Qty</th>
            <th className="py-2 pr-2">Unit</th>
            <th className="py-2 pr-2 text-right">Rate</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {spec.lines.map((l, i) => (
            <tr key={i} className="border-b border-divider align-top">
              <td className="py-2 pr-2 text-muted">{i + 1}</td>
              <td className="py-2 pr-2">{l.description}</td>
              <td className="py-2 pr-2 font-mono text-[12px]">{l.sacHsn}</td>
              <td className="num py-2 pr-2 text-right">{formatQty(l.qtyMilli)}</td>
              <td className="py-2 pr-2">{l.unit}</td>
              <td className="num py-2 pr-2 text-right">{inr(l.rate)}</td>
              <td className="num py-2 text-right">{inr(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="mt-4 flex flex-wrap justify-between gap-6">
        <div className="max-w-[420px] flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
            Amount in words
          </div>
          <div className="font-medium">{amountInWords(totals.total)}</div>
          {spec.showBank && letterhead.bankAccount ? (
            <div className="mt-3 text-muted">
              <div className="text-[11px] font-semibold uppercase tracking-[.05em]">
                Bank details
              </div>
              <div>
                {letterhead.bankName} · A/c {letterhead.bankAccount} · IFSC {letterhead.bankIfsc}
                {letterhead.bankBranch ? ` · ${letterhead.bankBranch}` : ''}
              </div>
            </div>
          ) : null}
        </div>
        <dl className="num grid min-w-[260px] grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          {totals.discount > 0 ? (
            <>
              <dt className="text-muted">Subtotal</dt>
              <dd className="text-right">{inr(totals.subtotal)}</dd>
              <dt className="text-muted">
                Discount{spec.discountPct ? ` ${spec.discountPct}%` : ''}
              </dt>
              <dd className="text-right">− {inr(totals.discount)}</dd>
            </>
          ) : null}
          <dt className="text-muted">Taxable value</dt>
          <dd className="text-right">{inr(totals.taxable)}</dd>
          {spec.interState ? (
            <>
              <dt className="text-muted">IGST</dt>
              <dd className="text-right">{inr(totals.igst)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted">CGST</dt>
              <dd className="text-right">{inr(totals.cgst)}</dd>
              <dt className="text-muted">SGST</dt>
              <dd className="text-right">{inr(totals.sgst)}</dd>
            </>
          )}
          {totals.roundOff !== 0 ? (
            <>
              <dt className="text-muted">Round off</dt>
              <dd className="text-right">{inr(totals.roundOff)}</dd>
            </>
          ) : null}
          <dt className="border-t border-line pt-1 font-semibold">Total</dt>
          <dd className="border-t border-line pt-1 text-right text-[16px] font-semibold">
            {inr(totals.total)}
          </dd>
        </dl>
      </section>
      {sections.length > 0 || extra ? (
        <section className="mt-6 flex flex-col gap-3 border-t border-line pt-4">
          {sections.map((s, i) => (
            <Section key={i} s={s} />
          ))}
          {extra}
        </section>
      ) : null}
      <footer className="mt-10 flex justify-end">
        <div className="text-center text-muted">
          <div className="mb-8">For {letterhead.legalName ?? letterhead.name}</div>
          <div className="border-t border-line pt-1">Authorised signatory</div>
        </div>
      </footer>
    </article>
  );
}
