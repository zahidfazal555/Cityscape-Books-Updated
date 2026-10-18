import { STATE_CODES, formatDate, type Paise } from '@csd/core';
import type { InvoiceDetail, PoDetail, ProformaDetail, QuoteDetail } from '@csd/services';
import { MODE_LABEL } from './sales';

export interface DocLine {
  description: string;
  sacHsn: string;
  qtyMilli: number;
  unit: string;
  rate: Paise;
  amount: Paise;
}

export interface DocTotals {
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  roundOff: Paise;
  total: Paise;
}

/** A block under the totals: terms, notes, or a list of amounts (payments, advances). */
export interface DocSection {
  heading?: string;
  /** Kept with its line breaks. */
  text?: string | null;
  /** Small muted print, e.g. "This is not a tax invoice." */
  note?: string;
  rows?: { label: string; amount: Paise }[];
  /** Shown when `rows` is empty. */
  empty?: string;
}

/**
 * Everything printed on an A4 quotation, proforma, tax invoice, credit note or purchase order.
 * The page (A4Document) and the PDF (A4Pdf) both render this, so they cannot drift apart.
 */
export interface DocSpec {
  title: string;
  number: string;
  /** "Bill to" on sales documents; "Vendor" on a purchase order. */
  partyLabel: string;
  party: { name: string; gstin?: string | null; address?: string | null };
  meta: [string, string][];
  lines: DocLine[];
  totals: DocTotals;
  discountPct?: number;
  interState: boolean;
  showBank: boolean;
  /** e.g. "DRAFT · not valid": printed too, so a draft can't pass for the final document. */
  watermark?: string | undefined;
  sections: DocSection[];
}

export const placeOfSupply = (code: string) => `${STATE_CODES[code] ?? 'State'} (${code})`;
const modeLabel = (mode: string) => MODE_LABEL[mode as keyof typeof MODE_LABEL] ?? mode;

export function invoiceSpec(inv: InvoiceDetail): DocSpec {
  return {
    title: 'TAX INVOICE',
    number: inv.number,
    partyLabel: 'Bill to',
    party: { name: inv.clientName, gstin: inv.clientGstin, address: inv.clientAddress },
    meta: [
      ['Invoice date', formatDate(inv.invoiceDate)],
      ['Due date', formatDate(inv.dueDate)],
      ['Place of supply', placeOfSupply(inv.placeOfSupply)],
      ['Project', `${inv.projectCode} · ${inv.projectName}`],
    ],
    lines: inv.lines,
    totals: inv,
    interState: inv.interState,
    showBank: true,
    watermark: inv.creditNote ? `CANCELLED · ${inv.creditNote.number}` : undefined,
    sections: [
      {
        heading: 'Payments received',
        rows: inv.receipts.map((r) => ({
          label: [r.number, formatDate(r.date), modeLabel(r.mode), r.reference]
            .filter(Boolean)
            .join(' · '),
          amount: r.amount,
        })),
        empty: 'None yet.',
        text: inv.notes,
      },
    ],
  };
}

/** The credit note that cancelled an invoice (FR-7.4): the invoice's lines, reversed in full. */
export function creditNoteSpec(inv: InvoiceDetail): DocSpec | null {
  const cn = inv.creditNote;
  if (!cn) return null;
  return {
    title: 'CREDIT NOTE',
    number: cn.number,
    partyLabel: 'Issued to',
    party: { name: inv.clientName, gstin: inv.clientGstin, address: inv.clientAddress },
    meta: [
      ['Credit note date', formatDate(cn.date)],
      ['Against invoice', inv.number],
      ['Invoice date', formatDate(inv.invoiceDate)],
      ['Place of supply', placeOfSupply(inv.placeOfSupply)],
      ['Project', `${inv.projectCode} · ${inv.projectName}`],
    ],
    lines: inv.lines,
    totals: inv,
    interState: inv.interState,
    showBank: false,
    sections: [{ heading: 'Reason', text: cn.reason }],
  };
}

export function quoteSpec(q: QuoteDetail): DocSpec {
  return {
    title: q.revision > 0 ? `QUOTATION · R${q.revision}` : 'QUOTATION',
    number: q.number,
    partyLabel: 'Bill to',
    party: { name: q.clientName, gstin: q.clientGstin, address: q.clientAddress },
    meta: [
      ['Quote date', formatDate(q.quoteDate)],
      ['Valid till', formatDate(q.validTill)],
      ['Place of supply', placeOfSupply(q.placeOfSupply)],
      ['Proposal', q.title],
      ...(q.site ? ([['Site', q.site]] as [string, string][]) : []),
    ],
    lines: q.lines.map((l, i) => ({ ...l, amount: q.totals.lines[i]?.amount ?? 0 })),
    totals: q.totals,
    discountPct: q.discountPct,
    interState: q.totals.interState,
    showBank: false,
    watermark:
      q.status === 'draft'
        ? q.discountPct > 0 && !q.discountApproved
          ? 'DRAFT · discount not approved'
          : 'DRAFT · not sent'
        : undefined,
    sections: q.terms ? [{ heading: 'Terms', text: q.terms }] : [],
  };
}

export function proformaSpec(pf: ProformaDetail): DocSpec {
  return {
    title: 'PROFORMA INVOICE',
    number: pf.number,
    partyLabel: 'Bill to',
    party: { name: pf.clientName, gstin: pf.clientGstin, address: pf.clientAddress },
    meta: [
      ['Date', formatDate(pf.pfDate)],
      ['Payment due', formatDate(pf.dueDate)],
      ['Stage', pf.stage],
      ['Place of supply', placeOfSupply(pf.placeOfSupply)],
      ['Project', pf.projectCode],
    ],
    lines: pf.lines.map((l, i) => ({ ...l, amount: pf.totals.lines[i]?.amount ?? 0 })),
    totals: pf.totals,
    interState: pf.totals.interState,
    showBank: true,
    // Only a live proforma is a payment request: drafts, cancelled and converted ones say so.
    watermark:
      pf.status === 'draft'
        ? 'DRAFT · not sent'
        : pf.status === 'cancelled'
          ? 'CANCELLED'
          : pf.status === 'converted'
            ? `CONVERTED · ${pf.invoiceNumber ?? 'tax invoice issued'}`
            : undefined,
    sections: [
      {
        note: 'This is not a tax invoice. A GST tax invoice is issued when the stage is billed.',
        heading: 'Advances received',
        rows: pf.advanceReceipts.map((r) => ({
          label: [
            r.number,
            formatDate(r.date),
            modeLabel(r.mode),
            r.applied ? 'applied to invoice' : null,
          ]
            .filter(Boolean)
            .join(' · '),
          amount: r.amount,
        })),
        empty: 'None yet.',
      },
    ],
  };
}

export function poSpec(po: PoDetail): DocSpec {
  return {
    title: 'PURCHASE ORDER',
    number: po.number,
    partyLabel: 'Vendor',
    party: { name: po.vendorName, gstin: po.vendorGstin },
    meta: [
      ['PO date', formatDate(po.poDate)],
      ['Deliver by', po.deliverBy ? formatDate(po.deliverBy) : '—'],
      ['Deliver to', po.projectCode],
    ],
    lines: po.lines.map((l, i) => ({ ...l, amount: po.totals.lines[i]?.amount ?? 0 })),
    totals: po.totals,
    interState: po.totals.interState,
    showBank: false,
    watermark:
      po.status === 'draft'
        ? 'DRAFT · not issued'
        : po.status === 'cancelled'
          ? 'CANCELLED'
          : undefined,
    sections: po.terms ? [{ text: po.terms }] : [],
  };
}

/** The PDF twin of an export URL: same filters, `format=pdf`. */
export const pdfHref = (href: string) => `${href}${href.includes('?') ? '&' : '?'}format=pdf`;

/** A safe download name: "CSD/26-27/0001" → "CSD-26-27-0001.pdf". */
export function pdfFilename(...parts: string[]): string {
  const base = parts
    .join(' ')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return `${base || 'document'}.pdf`;
}
