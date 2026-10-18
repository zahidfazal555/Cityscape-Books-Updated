import 'server-only';
import type {
  BillDetail,
  ClientStatement,
  Letterhead,
  PayrollLine,
  PayrollRun,
  ReceiptDetail,
} from '@csd/services';
import { pdfFilename, type DocSpec } from '@/lib/documents';
import { A4Pdf } from './a4';
import { PayslipsPdf, payMonth } from './payslip';
import { pdfResponse } from './render';
import { StatementPdf } from './statement';
import { TablePdf, type Cell } from './table';
import { BillPdf, ReceiptPdf } from './vouchers';

/** Route handlers are plain .ts (the route guard test reads them), so the JSX lives here. */
export function a4PdfResponse(spec: DocSpec, letterhead: Letterhead) {
  return pdfResponse(pdfFilename(spec.number), <A4Pdf spec={spec} letterhead={letterhead} />);
}

export function receiptPdfResponse(r: ReceiptDetail, letterhead: Letterhead) {
  return pdfResponse(pdfFilename(r.number), <ReceiptPdf r={r} letterhead={letterhead} />);
}

export function billPdfResponse(b: BillDetail, letterhead: Letterhead) {
  return pdfResponse(
    pdfFilename('Bill', b.billNo, b.vendorName),
    <BillPdf b={b} letterhead={letterhead} />,
  );
}

export function payslipsPdfResponse(
  run: PayrollRun,
  letterhead: Letterhead,
  only?: PayrollLine | undefined,
) {
  const name = only
    ? pdfFilename('Payslip', run.period, only.name)
    : pdfFilename('Payslips', run.period);
  return pdfResponse(name, <PayslipsPdf run={run} letterhead={letterhead} only={only} />);
}

export function statementPdfResponse(st: ClientStatement, letterhead: Letterhead) {
  return pdfResponse(
    pdfFilename('Statement', st.client.name, st.from, 'to', st.to),
    <StatementPdf st={st} letterhead={letterhead} />,
  );
}

export function tablePdfResponse(
  name: string,
  table: { title: string; subtitle?: string | undefined; rows: readonly (readonly Cell[])[] },
  letterhead: Letterhead,
) {
  return pdfResponse(pdfFilename(name), <TablePdf letterhead={letterhead} {...table} />);
}

export { payMonth };
