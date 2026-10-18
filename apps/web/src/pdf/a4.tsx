import 'server-only';
import { Text, View } from '@react-pdf/renderer';
import { amountInWords, formatQty } from '@csd/core';
import type { Letterhead } from '@csd/services';
import type { DocSection, DocSpec } from '@/lib/documents';
import { rupees } from '@/lib/format';
import {
  LetterheadBlock,
  LogoWatermark,
  MetaList,
  Party,
  PdfDocument,
  PdfPage,
  Signature,
  Watermark,
  companyName,
} from './kit';
import { C, s } from './theme';

const COLS = [
  { key: 'n', label: '#', width: '5%' },
  { key: 'desc', label: 'Description', width: '37%' },
  { key: 'sac', label: 'SAC/HSN', width: '11%' },
  { key: 'qty', label: 'Qty', width: '9%', right: true },
  { key: 'unit', label: 'Unit', width: '8%' },
  { key: 'rate', label: 'Rate', width: '14%', right: true },
  { key: 'amt', label: 'Amount', width: '16%', right: true },
] as const;

type Col = (typeof COLS)[number];
/** Same width and padding for heading and cells, so the columns line up. */
const cell = (c: Col) => ({
  width: c.width,
  paddingRight: c.key === 'amt' ? 0 : 6,
  paddingLeft: c.key === 'unit' ? 6 : 0,
  textAlign: 'right' in c ? ('right' as const) : ('left' as const),
});

function LinesTable({ spec }: { spec: DocSpec }) {
  return (
    <View style={{ marginTop: 10 }}>
      <View fixed style={[s.row, s.hr, { paddingVertical: 4 }]}>
        {COLS.map((c) => (
          <Text key={c.key} style={[s.label, cell(c), { marginBottom: 0 }]}>
            {c.label}
          </Text>
        ))}
      </View>
      {spec.lines.map((l, i) => {
        const cells = [
          String(i + 1),
          l.description,
          l.sacHsn,
          formatQty(l.qtyMilli),
          l.unit,
          rupees(l.rate),
          rupees(l.amount),
        ];
        return (
          <View
            key={i}
            wrap={false}
            style={[
              s.row,
              { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.divider },
            ]}
          >
            {COLS.map((c, j) => (
              <Text
                key={c.key}
                style={[
                  cell(c),
                  c.key === 'n' ? s.muted : {},
                  c.key === 'sac' ? [s.mono, { fontSize: 8.5 }] : {},
                ]}
              >
                {cells[j]}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function Totals({ spec }: { spec: DocSpec }) {
  const t = spec.totals;
  const rows: [string, string][] = [
    ...(t.discount > 0
      ? ([
          ['Subtotal', rupees(t.subtotal)],
          [`Discount${spec.discountPct ? ` ${spec.discountPct}%` : ''}`, `− ${rupees(t.discount)}`],
        ] as [string, string][])
      : []),
    ['Taxable value', rupees(t.taxable)],
    ...(spec.interState
      ? ([['IGST', rupees(t.igst)]] as [string, string][])
      : ([
          ['CGST', rupees(t.cgst)],
          ['SGST', rupees(t.sgst)],
        ] as [string, string][])),
    ...(t.roundOff !== 0 ? ([['Round off', rupees(t.roundOff)]] as [string, string][]) : []),
  ];
  return (
    <View style={{ width: 210, gap: 2 }}>
      {rows.map(([k, v]) => (
        <View key={k} style={s.between}>
          <Text style={s.muted}>{k}</Text>
          <Text>{v}</Text>
        </View>
      ))}
      <View style={[s.between, { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 3 }]}>
        <Text style={s.bold}>Total</Text>
        <Text style={[s.bold, { fontSize: 12 }]}>{rupees(t.total)}</Text>
      </View>
    </View>
  );
}

function Section({ section }: { section: DocSection }) {
  return (
    <View wrap={false} style={{ gap: 2, marginBottom: 6 }}>
      {section.note ? <Text style={[s.muted, { fontSize: 8 }]}>{section.note}</Text> : null}
      {section.heading ? (
        <Text style={[s.label, section.note ? { marginTop: 4 } : {}]}>{section.heading}</Text>
      ) : null}
      {section.rows?.length === 0 ? <Text style={s.muted}>{section.empty}</Text> : null}
      {section.rows?.map((r, i) => (
        <View key={i} style={[s.between, { gap: 10 }]}>
          <Text style={{ flexShrink: 1 }}>{r.label}</Text>
          <Text>{rupees(r.amount)}</Text>
        </View>
      ))}
      {section.text ? (
        <Text style={section.rows ? [s.muted, { marginTop: 4 }] : {}}>{section.text}</Text>
      ) : null}
    </View>
  );
}

/** The PDF twin of A4Document: same spec, same letterhead, A4 with page numbers. */
export function A4Pdf({ spec, letterhead }: { spec: DocSpec; letterhead: Letterhead }) {
  const sections = spec.sections.filter((x) => x.text || x.note || x.rows);
  const bank = spec.showBank && letterhead.bankAccount;
  return (
    <PdfDocument title={`${spec.title} ${spec.number}`}>
      <PdfPage footer={`${companyName(letterhead)} · ${spec.title} ${spec.number}`}>
        {spec.watermark ? <Watermark text={spec.watermark} /> : <LogoWatermark />}
        <LetterheadBlock letterhead={letterhead} title={spec.title} number={spec.number} />
        <View style={[s.between, s.hr, { paddingVertical: 10, gap: 16 }]}>
          <Party label={spec.partyLabel} {...spec.party} />
          <MetaList items={spec.meta} />
        </View>
        <LinesTable spec={spec} />
        <View wrap={false} style={[s.between, { marginTop: 10, gap: 20 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Amount in words</Text>
            <Text style={s.medium}>{amountInWords(spec.totals.total)}</Text>
            {bank ? (
              <View style={{ marginTop: 8 }}>
                <Text style={s.label}>Bank details</Text>
                <Text style={s.muted}>
                  {letterhead.bankName} · A/c {letterhead.bankAccount} · IFSC {letterhead.bankIfsc}
                  {letterhead.bankBranch ? ` · ${letterhead.bankBranch}` : ''}
                </Text>
              </View>
            ) : null}
          </View>
          <Totals spec={spec} />
        </View>
        {sections.length > 0 ? (
          <View style={{ marginTop: 14, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }}>
            {sections.map((x, i) => (
              <Section key={i} section={x} />
            ))}
          </View>
        ) : null}
        <Signature letterhead={letterhead} />
      </PdfPage>
    </PdfDocument>
  );
}
