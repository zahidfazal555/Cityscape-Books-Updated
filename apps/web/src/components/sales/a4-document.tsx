import type { ReactNode } from 'react';
import { STATE_CODES, amountInWords, formatDate, formatQty, type Paise } from '@csd/core';
import type { Letterhead } from '@csd/services';
import { rupees } from '@/lib/format';

export interface A4Line {
  description: string;
  sacHsn: string;
  qtyMilli: number;
  unit: string;
  rate: Paise;
  amount: Paise;
}

export interface A4Totals {
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  roundOff: Paise;
  total: Paise;
}

const inr = (p: Paise) => rupees(p);
const stateName = (code: string) => `${STATE_CODES[code] ?? 'State'} (${code})`;

/**
 * Printable A4 layout shared by quotation, proforma and tax invoice (README §5): letterhead,
 * title and number, bill-to, dates, lines, GST split, total in words, bank details.
 */
export function A4Document({
  title,
  number,
  letterhead,
  billTo,
  meta,
  lines,
  totals,
  discountPct,
  interState,
  showBank = true,
  watermark,
  footer,
}: {
  title: string;
  number: string;
  letterhead: Letterhead;
  billTo: { name: string; gstin?: string | null; address?: string | null };
  meta: readonly (readonly [string, string])[];
  lines: readonly A4Line[];
  totals: A4Totals;
  discountPct?: number;
  interState: boolean;
  showBank?: boolean;
  /** e.g. "DRAFT · not valid": printed too, so a draft can't pass for the final document. */
  watermark?: string | undefined;
  footer?: ReactNode;
}) {
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
      ) : null}
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
            {stateName(letterhead.stateCode)}
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
            Bill to
          </div>
          <div className="font-medium">{billTo.name}</div>
          {billTo.address ? (
            <div className="whitespace-pre-line text-muted">{billTo.address}</div>
          ) : null}
          {billTo.gstin ? <div className="text-muted">GSTIN {billTo.gstin}</div> : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 sm:justify-self-end">
          {meta.map(([k, v]) => (
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
          {lines.map((l, i) => (
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
          {showBank && letterhead.bankAccount ? (
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
              <dt className="text-muted">Discount{discountPct ? ` ${discountPct}%` : ''}</dt>
              <dd className="text-right">− {inr(totals.discount)}</dd>
            </>
          ) : null}
          <dt className="text-muted">Taxable value</dt>
          <dd className="text-right">{inr(totals.taxable)}</dd>
          {interState ? (
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
      {footer ? <section className="mt-6 border-t border-line pt-4">{footer}</section> : null}
      <footer className="mt-10 flex justify-end">
        <div className="text-center text-muted">
          <div className="mb-8">For {letterhead.legalName ?? letterhead.name}</div>
          <div className="border-t border-line pt-1">Authorised signatory</div>
        </div>
      </footer>
    </article>
  );
}

export function placeOfSupply(code: string): string {
  return stateName(code);
}

export const dateOf = (d: string) => formatDate(d);
