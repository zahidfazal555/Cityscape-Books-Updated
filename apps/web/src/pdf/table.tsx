import 'server-only';
import { Text, View } from '@react-pdf/renderer';
import { formatDate, formatInr, fromDecimalString } from '@csd/core';
import type { Letterhead } from '@csd/services';
import { istDateTime } from '@/lib/format';
import { PdfDocument, PdfPage, companyName } from './kit';
import { C, s } from './theme';

export type Cell = string | number;

const MONEY = /^-?\d+\.\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Export rows hold machine values ("125000.00", "2026-10-18"); print them the way people read. */
export function printCell(v: Cell): string {
  const t = String(v);
  // Money stays integer paise until it is printed (ADR 0001); the header says amounts are in ₹.
  if (MONEY.test(t)) return formatInr(fromDecimalString(t)).replace('₹', '');
  if (ISO_DATE.test(t)) return formatDate(t);
  return t;
}

const isNumeric = (v: Cell | undefined) =>
  v === undefined || v === '' || typeof v === 'number' || MONEY.test(String(v));

/** Column widths from content length, so long names get room and amounts stay on one line. */
function layout(header: Cell[], rows: Cell[][]) {
  const lens = header.map((h, i) =>
    Math.min(40, Math.max(String(h).length, ...rows.map((r) => printCell(r[i] ?? '').length), 4)),
  );
  const sum = lens.reduce((a, b) => a + b, 0);
  return header.map((h, i) => ({
    label: String(h),
    width: `${((lens[i] ?? 4) / sum) * 100}%`,
    right: rows.length > 0 && rows.every((r) => isNumeric(r[i])),
  }));
}

const BOLD_ROW = /^(total|totals|opening balance|closing balance)$/i;

/**
 * Any list or report as an A4 table (FR-3.4.5, Tech Spec §11 `format=pdf`): the same rows as its
 * CSV export. Wide reports turn landscape; the heading row repeats on every page.
 */
export function TablePdf({
  letterhead,
  title,
  subtitle,
  rows,
}: {
  letterhead: Letterhead;
  title: string;
  subtitle?: string | undefined;
  rows: readonly (readonly Cell[])[];
}) {
  const [header = [], ...body] = rows.map((r) => [...r]);
  const cols = layout(header, body);
  const landscape = header.length > 7;
  const generated = istDateTime(new Date().toISOString());
  return (
    <PdfDocument title={title}>
      <PdfPage landscape={landscape} footer={`${companyName(letterhead)} · ${title}`}>
        <View style={[s.between, s.hr, { paddingBottom: 8, gap: 16 }]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={s.title}>{title}</Text>
            {subtitle ? <Text style={s.muted}>{subtitle}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.bold}>{companyName(letterhead)}</Text>
            {letterhead.gstin ? <Text style={s.muted}>GSTIN {letterhead.gstin}</Text> : null}
            <Text style={[s.muted, { fontSize: 7.5 }]}>Generated {generated}</Text>
          </View>
        </View>
        <View
          fixed
          style={[
            s.row,
            { borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 4, marginTop: 8 },
          ]}
        >
          {cols.map((c, i) => (
            <Text
              key={i}
              style={[
                s.label,
                { width: c.width, paddingRight: 4, marginBottom: 0 },
                c.right ? s.right : {},
              ]}
            >
              {c.label}
            </Text>
          ))}
        </View>
        {body.length === 0 ? (
          <Text style={[s.muted, { marginTop: 10 }]}>Nothing to show.</Text>
        ) : (
          body.map((r, ri) => {
            const strong = BOLD_ROW.test(String(r[0] ?? '')) || BOLD_ROW.test(String(r[1] ?? ''));
            return (
              <View
                key={ri}
                wrap={false}
                style={[
                  s.row,
                  { paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: C.divider },
                  strong ? { backgroundColor: C.thead } : {},
                ]}
              >
                {cols.map((c, i) => (
                  <Text
                    key={i}
                    style={[
                      { width: c.width, paddingRight: 4, fontSize: landscape ? 8 : 8.5 },
                      c.right ? s.right : {},
                      strong ? s.bold : {},
                    ]}
                  >
                    {printCell(r[i] ?? '')}
                  </Text>
                ))}
              </View>
            );
          })
        )}
        <Text style={[s.muted, { marginTop: 8, fontSize: 7.5 }]}>
          {body.length} {body.length === 1 ? 'row' : 'rows'} · amounts in ₹
        </Text>
      </PdfPage>
    </PdfDocument>
  );
}
