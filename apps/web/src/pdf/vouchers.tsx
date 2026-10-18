import 'server-only';
import { Text, View } from '@react-pdf/renderer';
import { CATEGORY_LABEL, amountInWords, formatDate, type Paise } from '@csd/core';
import type { BillDetail, Letterhead, ReceiptDetail } from '@csd/services';
import { rupees } from '@/lib/format';
import { MODE_LABEL } from '@/lib/sales';
import {
  LetterheadBlock,
  LogoWatermark,
  MetaList,
  Party,
  PdfDocument,
  PdfPage,
  Signature,
  companyName,
} from './kit';
import { C, s } from './theme';

function AmountBox({ label, amount }: { label: string; amount: Paise }) {
  return (
    <View
      style={{
        marginTop: 14,
        padding: 10,
        borderWidth: 1,
        borderColor: C.line,
        backgroundColor: C.thead,
        gap: 3,
      }}
    >
      <View style={s.between}>
        <Text style={s.label}>{label}</Text>
        <Text style={[s.bold, { fontSize: 14 }]}>{rupees(amount)}</Text>
      </View>
      <Text style={s.medium}>{amountInWords(amount)}</Text>
    </View>
  );
}

/** A client receipt (Req §6): money received against an invoice, or an advance on a proforma. */
export function ReceiptPdf({ r, letterhead }: { r: ReceiptDetail; letterhead: Letterhead }) {
  const against: [string, string] = r.invoiceNumber
    ? ['Against invoice', r.invoiceNumber]
    : ['Advance on proforma', r.proformaNumber ?? '—'];
  const meta: [string, string][] = [
    ['Receipt date', formatDate(r.receiptDate)],
    ['Project', `${r.projectCode} · ${r.projectName}`],
    against,
    ['Mode', MODE_LABEL[r.mode]],
    ...(r.reference ? ([['Reference', r.reference]] as [string, string][]) : []),
  ];
  return (
    <PdfDocument title={`Receipt ${r.number}`}>
      <PdfPage footer={`${companyName(letterhead)} · RECEIPT ${r.number}`}>
        <LogoWatermark />
        <LetterheadBlock letterhead={letterhead} title="RECEIPT" number={r.number} />
        <View style={[s.between, s.hr, { paddingVertical: 10, gap: 16 }]}>
          <Party
            label="Received from"
            name={r.clientName}
            gstin={r.clientGstin}
            address={r.clientAddress}
          />
          <MetaList items={meta} />
        </View>
        <AmountBox label="Amount received" amount={r.amount} />
        {r.proformaNumber && !r.invoiceNumber ? (
          <Text style={[s.muted, { marginTop: 8, fontSize: 8.5 }]}>
            An advance against proforma {r.proformaNumber}. It is adjusted on the GST tax invoice
            when the stage is billed.
          </Text>
        ) : null}
        {r.receivedBy ? (
          <Text style={[s.muted, { marginTop: 8 }]}>Received by {r.receivedBy}</Text>
        ) : null}
        <Signature letterhead={letterhead} />
      </PdfPage>
    </PdfDocument>
  );
}

/** A vendor's bill as recorded in the books (FR-12): an internal copy for files and the CA. */
export function BillPdf({ b, letterhead }: { b: BillDetail; letterhead: Letterhead }) {
  const tax: [string, string][] = b.interState
    ? [[`IGST ${b.gstRate}%`, rupees(b.igst)]]
    : [
        [`CGST ${b.gstRate / 2}%`, rupees(b.cgst)],
        [`SGST ${b.gstRate / 2}%`, rupees(b.sgst)],
      ];
  const rows: [string, string][] = [
    ['Taxable value', rupees(b.taxable)],
    ...tax,
    ...(b.roundOff !== 0 ? ([['Round off', rupees(b.roundOff)]] as [string, string][]) : []),
  ];
  const paid: [string, string][] = [
    ['Paid', rupees(b.paid)],
    ...(b.pending > 0
      ? ([['Payments waiting for approval', rupees(b.pending)]] as [string, string][])
      : []),
    ['Balance due', rupees(b.balance)],
  ];
  return (
    <PdfDocument title={`Purchase bill ${b.billNo}`}>
      <PdfPage footer={`${companyName(letterhead)} · PURCHASE BILL ${b.billNo} · ${b.vendorName}`}>
        <LetterheadBlock letterhead={letterhead} title="PURCHASE BILL" number={b.billNo} />
        <View style={[s.between, s.hr, { paddingVertical: 10, gap: 16 }]}>
          <Party label="Vendor" name={b.vendorName} gstin={b.vendorGstin} />
          <MetaList
            items={[
              ['Bill date', formatDate(b.billDate)],
              ['Due date', formatDate(b.dueDate)],
              ['Project', b.projectCode],
              ['Category', CATEGORY_LABEL[b.category]],
              ...(b.purchaseOrderNumber
                ? ([['Purchase order', b.purchaseOrderNumber]] as [string, string][])
                : []),
              ['Input tax credit', b.itcEligible ? 'Eligible' : 'Not eligible'],
            ]}
          />
        </View>
        <View style={{ marginTop: 12, marginLeft: 'auto', width: 260, gap: 2 }}>
          {rows.map(([k, v]) => (
            <View key={k} style={s.between}>
              <Text style={s.muted}>{k}</Text>
              <Text>{v}</Text>
            </View>
          ))}
          <View style={[s.between, { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 3 }]}>
            <Text style={s.bold}>Bill total</Text>
            <Text style={[s.bold, { fontSize: 12 }]}>{rupees(b.total)}</Text>
          </View>
          <View style={{ marginTop: 8, gap: 2 }}>
            {paid.map(([k, v]) => (
              <View key={k} style={s.between}>
                <Text style={k === 'Balance due' ? s.bold : s.muted}>{k}</Text>
                <Text style={k === 'Balance due' ? s.bold : {}}>{v}</Text>
              </View>
            ))}
          </View>
        </View>
        {b.notes ? (
          <View style={{ marginTop: 14 }}>
            <Text style={s.label}>Notes</Text>
            <Text>{b.notes}</Text>
          </View>
        ) : null}
        <Text style={[s.muted, { marginTop: 20, fontSize: 8 }]}>
          Recorded from the vendor’s bill. The vendor’s own bill is the tax document.
        </Text>
      </PdfPage>
    </PdfDocument>
  );
}
