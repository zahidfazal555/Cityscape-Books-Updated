import 'server-only';
import { Text, View } from '@react-pdf/renderer';
import { amountInWords, formatDate, isPtMonth } from '@csd/core';
import type { Letterhead, PayrollLine, PayrollRun } from '@csd/services';
import { rupees } from '@/lib/format';
import { MODE_LABEL } from '@/lib/sales';
import {
  LetterheadBlock,
  LogoWatermark,
  PdfDocument,
  PdfPage,
  Watermark,
  companyName,
} from './kit';
import { C, s } from './theme';

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const payMonth = (period: string) => MONTH.format(new Date(`${period}-01T00:00:00Z`));

function Slip({ run, l, letterhead }: { run: PayrollRun; l: PayrollLine; letterhead: Letterhead }) {
  const approved = run.status === 'approved';
  const month = payMonth(run.period);
  const rows: [string, string][] = [
    ['Less: TDS on salary', rupees(l.tds)],
    [`Less: professional tax${isPtMonth(run.period) ? ' (half-year)' : ''}`, rupees(l.pt)],
    ['Less: advance recovery', rupees(l.recovery)],
  ];
  return (
    <PdfPage footer={`${companyName(letterhead)} · Payslip ${month} · ${l.name}`}>
      {/* BUG-150: every page of an unapproved run says so, not only the first. */}
      {approved ? <LogoWatermark /> : <Watermark text="DRAFT · not approved · not a payslip" />}
      <LetterheadBlock letterhead={letterhead} title="PAYSLIP" number={month} />
      <View style={[s.between, s.hr, { paddingVertical: 10, gap: 16 }]}>
        <View>
          <Text style={s.label}>Employee</Text>
          <Text style={[s.bold, { fontSize: 11 }]}>{l.name}</Text>
          <Text style={s.muted}>{l.roleTitle}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.muted}>
            {approved ? 'Paid' : 'Pay date'} {formatDate(run.payDate)}
          </Text>
          <Text style={s.muted}>
            {MODE_LABEL[run.mode]}
            {run.reference ? ` · ${run.reference}` : ''}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 12, gap: 4, width: 320 }}>
        <View style={s.between}>
          <Text>Gross salary</Text>
          <Text>{rupees(l.gross)}</Text>
        </View>
        {rows.map(([k, v]) => (
          <View key={k} style={s.between}>
            <Text style={s.muted}>{k}</Text>
            <Text>{v}</Text>
          </View>
        ))}
        <View style={[s.between, { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 4 }]}>
          <Text style={s.bold}>Net pay</Text>
          <Text style={[s.bold, { fontSize: 12 }]}>{rupees(l.net)}</Text>
        </View>
        <Text style={[s.muted, { marginTop: 2 }]}>{amountInWords(l.net)}</Text>
      </View>
      <Text style={[s.muted, { marginTop: 28, fontSize: 8 }]}>
        This is a computer-generated payslip.
      </Text>
    </PdfPage>
  );
}

/** Payslips for a run (FR-17.1), one per page; `only` limits it to one employee. */
export function PayslipsPdf({
  run,
  letterhead,
  only,
}: {
  run: PayrollRun;
  letterhead: Letterhead;
  only?: PayrollLine | undefined;
}) {
  const lines = only ? [only] : run.lines;
  return (
    <PdfDocument title={`Payslips ${payMonth(run.period)}`}>
      {lines.map((l) => (
        <Slip key={l.employeeId} run={run} l={l} letterhead={letterhead} />
      ))}
    </PdfDocument>
  );
}
