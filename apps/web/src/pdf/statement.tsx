import 'server-only';
import { Text, View } from '@react-pdf/renderer';
import { formatDate, type Paise } from '@csd/core';
import type { ClientStatement, Letterhead } from '@csd/services';
import { rupees } from '@/lib/format';
import {
  LetterheadBlock,
  LogoWatermark,
  MetaList,
  Party,
  PdfDocument,
  PdfPage,
  companyName,
} from './kit';
import { C, s } from './theme';

const W = { date: '14%', part: '44%', dr: '14%', cr: '14%', bal: '14%' };
const HEAD = [
  ['Date', W.date],
  ['Particulars', W.part],
  ['Debit', W.dr],
  ['Credit', W.cr],
  ['Balance', W.bal],
] as const;
const money = (p: Paise) => (p === 0 ? '' : rupees(p));
/** Positive: the client owes us. Negative: we hold an advance for them. */
export const balanceText = (p: Paise) =>
  p < 0 ? `${rupees(-p)} advance` : p === 0 ? rupees(0) : rupees(p);

function Row({
  cells,
  strong,
  muted,
}: {
  cells: [string, string, string, string, string];
  strong?: boolean;
  muted?: boolean;
}) {
  const [date, part, dr, cr, bal] = cells;
  return (
    <View
      wrap={false}
      style={[
        s.row,
        { paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: C.divider },
        strong ? { backgroundColor: C.thead } : {},
      ]}
    >
      <Text style={[{ width: W.date }, muted ? s.muted : {}]}>{date}</Text>
      <Text style={[{ width: W.part, paddingRight: 6 }, strong ? s.bold : {}]}>{part}</Text>
      <Text style={[{ width: W.dr }, s.right]}>{dr}</Text>
      <Text style={[{ width: W.cr }, s.right]}>{cr}</Text>
      <Text style={[{ width: W.bal }, s.right, strong ? s.bold : {}]}>{bal}</Text>
    </View>
  );
}

/** A client's statement of account: what was invoiced, what was received, what is due. */
export function StatementPdf({ st, letterhead }: { st: ClientStatement; letterhead: Letterhead }) {
  const period = `${formatDate(st.from)} to ${formatDate(st.to)}`;
  const due = st.closing;
  return (
    <PdfDocument title={`Statement of account ${st.client.name}`}>
      <PdfPage footer={`${companyName(letterhead)} · Statement · ${st.client.name} · ${period}`}>
        <LogoWatermark />
        <LetterheadBlock letterhead={letterhead} title="STATEMENT OF ACCOUNT" />
        <View style={[s.between, s.hr, { paddingVertical: 10, gap: 16 }]}>
          <Party label="Client" {...st.client} />
          <MetaList
            items={[
              ['Period', period],
              ['Opening balance', balanceText(st.opening)],
              ['Invoiced', rupees(st.debit)],
              ['Received and credited', rupees(st.credit)],
            ]}
          />
        </View>
        <View fixed style={[s.row, s.hr, { paddingVertical: 4, marginTop: 10 }]}>
          {HEAD.map(([h, width], i) => (
            <Text key={h} style={[s.label, { width, marginBottom: 0 }, i > 1 ? s.right : {}]}>
              {h}
            </Text>
          ))}
        </View>
        <Row
          muted
          cells={[formatDate(st.from), 'Opening balance', '', '', balanceText(st.opening)]}
        />
        {st.lines.map((l, i) => (
          <Row
            key={i}
            cells={[
              formatDate(l.date),
              l.particulars,
              money(l.debit),
              money(l.credit),
              balanceText(l.balance),
            ]}
          />
        ))}
        <Row
          strong
          cells={[
            formatDate(st.to),
            'Closing balance',
            rupees(st.debit),
            rupees(st.credit),
            balanceText(due),
          ]}
        />
        <View
          wrap={false}
          style={{
            marginTop: 14,
            marginLeft: 'auto',
            width: 260,
            padding: 10,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.thead,
          }}
        >
          <View style={s.between}>
            <Text style={s.label}>{due < 0 ? 'Advance held for you' : 'Amount due'}</Text>
            <Text style={[s.bold, { fontSize: 13 }]}>{rupees(Math.abs(due))}</Text>
          </View>
          <Text style={[s.muted, { fontSize: 8 }]}>as on {formatDate(st.to)}</Text>
        </View>
        {letterhead.bankAccount && due > 0 ? (
          <View style={{ marginTop: 12 }}>
            <Text style={s.label}>Bank details</Text>
            <Text style={s.muted}>
              {letterhead.bankName} · A/c {letterhead.bankAccount} · IFSC {letterhead.bankIfsc}
              {letterhead.bankBranch ? ` · ${letterhead.bankBranch}` : ''}
            </Text>
          </View>
        ) : null}
      </PdfPage>
    </PdfDocument>
  );
}
