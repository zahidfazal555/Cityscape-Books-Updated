import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvoiceLine, Letterhead } from '@csd/services';
import { creditNoteSpec, invoiceSpec, pdfFilename, type DocSpec } from '../src/lib/documents';
import {
  a4PdfResponse,
  billPdfResponse,
  payslipsPdfResponse,
  receiptPdfResponse,
  statementPdfResponse,
  tablePdfResponse,
} from '../src/pdf/responses';
import { balanceText } from '../src/pdf/statement';
import { printCell } from '../src/pdf/table';

/** Synthetic data only (ENGINEERING-STANDARDS §3). */
export const LETTERHEAD: Letterhead = {
  name: 'Sample Interiors',
  legalName: null,
  gstin: '33AAAPZ1234Q1Z5',
  stateCode: '33',
  address: '12, First Street,\nAdyar, Chennai - 600020',
  phone: '044 2345 6789',
  email: 'accounts@sample.example.test',
  bankName: 'Example Bank',
  bankAccount: '001234567890',
  bankIfsc: 'EXMP0001234',
  bankBranch: 'Adyar',
};

const line = (n: number): InvoiceLine => ({
  description: `Modular kitchen – stage ${n}, carcass and shutters with soft-close hinges`,
  sacHsn: '995414',
  qtyMilli: 1000,
  unit: 'lot',
  rate: 1_00_000_00,
  gstRate: 18,
  amount: 1_00_000_00,
  discount: 0,
  taxable: 1_00_000_00,
  cgst: 9_000_00,
  sgst: 9_000_00,
  igst: 0,
});

export const INVOICE = {
  id: 'inv-1',
  number: 'CSD/26-27/0007',
  invoiceDate: '2026-10-10',
  dueDate: '2026-10-25',
  clientName: 'Sample Client',
  clientGstin: null,
  clientAddress: 'Besant Nagar, Chennai',
  placeOfSupply: '33',
  projectCode: 'CSD-PRJ-0001',
  projectName: 'Sample Villa',
  interState: false,
  subtotal: 3_00_000_00,
  discount: 0,
  taxable: 3_00_000_00,
  cgst: 27_000_00,
  sgst: 27_000_00,
  igst: 0,
  roundOff: 0,
  total: 3_54_000_00,
  notes: 'Thank you for your business.',
  lines: [line(1), line(2), line(3)],
  receipts: [
    {
      id: 'r1',
      number: 'RCT/26-27/0003',
      date: '2026-10-12',
      amount: 1_00_000_00,
      mode: 'upi',
      reference: 'UTR123',
    },
  ],
  creditNote: null,
} as unknown as Parameters<typeof invoiceSpec>[0];

export const samplesDir = process.env['PDF_SAMPLES_DIR'];

export async function pdfOf(res: Response, sample?: string) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (samplesDir && sample) writeFileSync(path.join(samplesDir, sample), buf);
  return {
    buf,
    text: buf.toString('latin1'),
    pages: buf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0,
  };
}

describe('A4 document PDFs (FR-3.4.5)', () => {
  it('a tax invoice renders as a one-page A4 PDF download named after its number', async () => {
    const res = await a4PdfResponse(invoiceSpec(INVOICE), LETTERHEAD);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="CSD-26-27-0007.pdf"',
    );
    const pdf = await pdfOf(res, 'invoice.pdf');
    expect(pdf.text.startsWith('%PDF-')).toBe(true);
    expect(pdf.pages).toBe(1);
  });

  it('long documents flow onto more pages; a cancelled invoice and its credit note both print', async () => {
    const long = { ...INVOICE, lines: Array.from({ length: 40 }, (_, i) => line(i + 1)) };
    const longPdf = await pdfOf(await a4PdfResponse(invoiceSpec(long), LETTERHEAD), 'long.pdf');
    expect(longPdf.pages).toBeGreaterThan(1);

    const cancelled = {
      ...INVOICE,
      creditNote: { number: 'CN/26-27/0001', date: '2026-10-15', reason: 'Raised in error' },
    };
    expect(invoiceSpec(cancelled).watermark).toBe('CANCELLED · CN/26-27/0001');
    await pdfOf(await a4PdfResponse(invoiceSpec(cancelled), LETTERHEAD), 'cancelled.pdf');
    const cn = creditNoteSpec(cancelled) as DocSpec;
    expect(cn.title).toBe('CREDIT NOTE');
    const res = await a4PdfResponse(cn, LETTERHEAD);
    expect(res.headers.get('content-disposition')).toContain('CN-26-27-0001.pdf');
    expect((await pdfOf(res, 'credit-note.pdf')).pages).toBe(1);
    expect(creditNoteSpec(INVOICE)).toBeNull();
  });

  it('file names are safe whatever the document number holds', () => {
    expect(pdfFilename('QT/26-27/0001')).toBe('QT-26-27-0001.pdf');
    expect(pdfFilename('Statement', 'A "quoted" / client', '2026-10-01')).toBe(
      'Statement-A-quoted---client-2026-10-01.pdf',
    );
    expect(pdfFilename('')).toBe('document.pdf');
  });
});

describe('receipts, bills, payslips, statements and reports as PDF', () => {
  it('a receipt and a purchase bill each print on one page', async () => {
    const receipt = {
      id: 'r1',
      number: 'RCT/26-27/0003',
      receiptDate: '2026-10-12',
      clientName: 'Sample Client',
      clientGstin: null,
      clientAddress: 'Besant Nagar, Chennai',
      projectId: 'p1',
      projectCode: 'CSD-PRJ-0001',
      projectName: 'Sample Villa',
      invoiceNumber: 'CSD/26-27/0007',
      proformaNumber: null,
      applied: false,
      amount: 1_00_000_00,
      mode: 'upi' as const,
      reference: 'UTR123',
      receivedBy: 'Accounts',
    };
    const r = await receiptPdfResponse(receipt, LETTERHEAD);
    expect(r.headers.get('content-disposition')).toContain('RCT-26-27-0003.pdf');
    expect((await pdfOf(r, 'receipt.pdf')).pages).toBe(1);

    const bill = {
      id: 'b1',
      billNo: 'INV/889',
      billDate: '2026-10-05',
      dueDate: '2026-11-04',
      vendorId: 'v1',
      vendorName: 'Sample Plywood Traders',
      vendorGstin: '33AAAPZ1234Q1Z5',
      projectId: 'p1',
      projectCode: 'CSD-PRJ-0001',
      category: 'material' as const,
      purchaseOrderId: null,
      purchaseOrderNumber: 'PO/26-27/0002',
      taxable: 50_000_00,
      gst: 9_000_00,
      total: 59_000_00,
      paid: 20_000_00,
      pending: 5_000_00,
      balance: 34_000_00,
      status: 'partially_paid',
      version: 1,
      gstRate: 18,
      interState: false,
      itcEligible: true,
      cgst: 4_500_00,
      sgst: 4_500_00,
      igst: 0,
      roundOff: 0,
      notes: 'Delivered to site in two lots.',
    } as unknown as Parameters<typeof billPdfResponse>[0];
    const b = await billPdfResponse(bill, LETTERHEAD);
    expect(b.headers.get('content-disposition')).toContain(
      'Bill-INV-889-Sample-Plywood-Traders.pdf',
    );
    expect((await pdfOf(b, 'bill.pdf')).pages).toBe(1);
  });

  it('a payroll run prints one payslip per page; one employee prints alone; drafts are marked', async () => {
    const slip = (n: number) => ({
      employeeId: `e${n}`,
      name: `Staff ${n}`,
      roleTitle: 'Site supervisor',
      gross: 30_000_00,
      tds: 1_000_00,
      pt: 0,
      recovery: 2_000_00,
      net: 27_000_00,
    });
    const run = {
      id: 'run1',
      period: '2026-09',
      payDate: '2026-09-30',
      mode: 'bank' as const,
      reference: 'NEFT batch 12',
      totals: slip(0),
      status: 'approved' as const,
      rejectReason: null,
      submittedBy: null,
      createdBy: null,
      submittedAt: '2026-09-30T10:00:00Z',
      staff: 3,
      lines: [slip(1), slip(2), slip(3)],
    };
    const all = await payslipsPdfResponse(run, LETTERHEAD);
    expect(all.headers.get('content-disposition')).toContain('Payslips-2026-09.pdf');
    expect((await pdfOf(all, 'payslips.pdf')).pages).toBe(3);
    const one = await payslipsPdfResponse(run, LETTERHEAD, run.lines[1]);
    expect(one.headers.get('content-disposition')).toContain('Payslip-2026-09-Staff-2.pdf');
    expect((await pdfOf(one)).pages).toBe(1);
    await pdfOf(
      await payslipsPdfResponse({ ...run, status: 'pending' }, LETTERHEAD),
      'payslips-draft.pdf',
    );
  });

  it('a client statement and a report table render; wide reports are landscape', async () => {
    const st = {
      client: { id: 'c1', name: 'Sample Client', gstin: null, address: 'Besant Nagar, Chennai' },
      from: '2026-04-01',
      to: '2026-10-31',
      opening: 0,
      lines: [
        {
          date: '2026-10-10',
          particulars: 'Tax invoice CSD/26-27/0007',
          debit: 3_54_000_00,
          credit: 0,
          balance: 3_54_000_00,
        },
        {
          date: '2026-10-12',
          particulars: 'Receipt RCT/26-27/0003 for CSD/26-27/0007',
          debit: 0,
          credit: 1_00_000_00,
          balance: 2_54_000_00,
        },
      ],
      debit: 3_54_000_00,
      credit: 1_00_000_00,
      closing: 2_54_000_00,
    };
    const s = await statementPdfResponse(st, LETTERHEAD);
    expect(s.headers.get('content-disposition')).toContain(
      'Statement-Sample-Client-2026-04-01-to-2026-10-31.pdf',
    );
    expect((await pdfOf(s, 'statement.pdf')).pages).toBe(1);
    expect(balanceText(-5_000_00)).toBe('₹5,000 advance');

    const narrow = await tablePdfResponse(
      'receivables',
      {
        title: 'Receivables',
        subtitle: 'As on 18 Oct 2026',
        rows: [
          ['Number', 'Client', 'Date', 'Balance'],
          ['CSD/26-27/0007', 'Sample Client', '2026-10-10', '254000.00'],
          ['Total', '', '', '254000.00'],
        ],
      },
      LETTERHEAD,
    );
    const n = await pdfOf(narrow, 'table.pdf');
    expect(n.pages).toBe(1);
    expect(n.text).not.toContain('/Rotate');
    const wide = await tablePdfResponse(
      'category',
      { title: 'Spend by category', rows: [Array.from({ length: 11 }, (_, i) => `Col ${i}`)] },
      LETTERHEAD,
    );
    const w = await pdfOf(wide, 'table-wide.pdf');
    // Landscape A4: the media box is wider than it is tall.
    expect(w.text).toMatch(/\/MediaBox \[0 0 841\.8\d* 595\.2\d*\]/);
  });

  it('export cells print the way people read them', () => {
    expect(printCell('1234567.50')).toBe('12,34,567.50');
    expect(printCell('-500.00')).toBe('-500.00');
    expect(printCell('2026-10-18')).toBe('18 Oct 2026');
    expect(printCell('CSD/26-27/0001')).toBe('CSD/26-27/0001');
    expect(printCell(42)).toBe('42');
  });
});

describe('PDF exports stay a readable size', () => {
  it('more rows than a PDF can hold is refused before anything is rendered', async () => {
    const { exportResponse, PDF_MAX_ROWS } = await import('../src/lib/export-response');
    const owner = {
      userId: 'u',
      companyId: 'c',
      role: 'owner',
      rights: {},
      projects: 'all',
      active: true,
    } as never;
    const rows = [['A'], ...Array.from({ length: PDF_MAX_ROWS + 1 }, (_, i) => [i])];
    await expect(exportResponse(owner, 'pdf', 'big', { title: 'Big' }, rows)).rejects.toMatchObject(
      {
        status: 422,
        field: 'format',
      },
    );
    const csv = await exportResponse(owner, 'csv', 'big', { title: 'Big' }, rows);
    expect(csv.headers.get('content-type')).toContain('text/csv');
  });
});
