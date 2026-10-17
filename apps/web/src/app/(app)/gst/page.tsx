import {
  addHeads,
  can,
  formatDate,
  projectScope,
  todayIn,
  type Paise,
  type TaxHeads,
} from '@csd/core';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { DownloadLink, LinkTabs } from '@/components/accounts/tabs';
import { Cards } from '@/components/sales/filter-chips';
import { EmptyState } from '@/components/ui';
import type { GstMonth } from '@csd/services';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

const MONTH = new Intl.DateTimeFormat('en-IN', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The current month and the five before it, newest last (README §12 month chips). */
function recentPeriods(today: string): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: 6 }, (_v, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

const total = (t: TaxHeads): Paise => t.igst + t.cgst + t.sgst;

function TaxCells({ t }: { t: TaxHeads }) {
  return (
    <>
      <span className="num text-right">{rupees(t.igst)}</span>
      <span className="num text-right">{rupees(t.cgst)}</span>
      <span className="num text-right">{rupees(t.sgst)}</span>
    </>
  );
}

export default async function GstPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'gst', 'view') || projectScope(actor) !== null)
    return <EmptyState>GST returns need GST rights and access to all projects.</EmptyState>;
  const periods = recentPeriods(todayIn());
  const raw = (await searchParams).period;
  const period = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : (periods.at(-1) ?? todayIn().slice(0, 7));
  const m = await services().gst.month(actor, period);
  const output = addHeads(
    m.outward.tax,
    addHeads(m.advancesReceived.tax, m.advancesAdjusted.tax, -1),
  );
  const cash = total(m.setOff.cash);
  const label = (p: string) => MONTH.format(new Date(`${p}-01T00:00:00Z`));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="GST returns"
        subtitle={`GSTR-1 due ${formatDate(m.gstr1DueDate)} · GSTR-3B and payment due ${formatDate(m.dueDate)}`}
        action={
          <div className="flex gap-2">
            <DownloadLink href={`/api/v1/gst/${period}/gstr1`}>GSTR-1 JSON</DownloadLink>
            <DownloadLink href={`/api/v1/gst/${period}/export`}>CSV</DownloadLink>
          </div>
        }
      />
      <LinkTabs
        value={period}
        items={periods.map((p) => ({ value: p, label: label(p), href: `/gst?period=${p}` }))}
      />
      <Cards
        items={[
          ['Output tax', rupees(total(output))],
          ['Input tax credit', rupees(total(m.itc) + total(m.openingCredit))],
          cash > 0
            ? [`Net payable by ${formatDate(m.dueDate)}`, rupees(cash)]
            : ['ITC carried forward', rupees(total(m.setOff.carryForward))],
        ]}
      />
      <Summary3B m={m} />
      <Gstr1Documents m={m} />
      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-[15px] font-semibold">HSN / SAC summary</h2>
          {m.hsn.length === 0 ? (
            <EmptyState>None.</EmptyState>
          ) : (
            <Table columns="0.8fr 0.6fr 0.5fr 1fr 1fr" minWidth={480}>
              <Row head>
                <span>HSN/SAC</span>
                <span>Supply</span>
                <span>Rate</span>
                <span className="text-right">Taxable</span>
                <span className="text-right">Tax</span>
              </Row>
              {m.hsn.map((h) => (
                <Row key={`${h.b2b}-${h.hsn}-${h.rate}`}>
                  <span className="font-mono text-[12px]">{h.hsn}</span>
                  <span>{h.b2b ? 'B2B' : 'B2C'}</span>
                  <span>{h.rate}%</span>
                  <span className="num text-right">{rupees(h.taxable)}</span>
                  <span className="num text-right">{rupees(total(h.tax))}</span>
                </Row>
              ))}
            </Table>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-[15px] font-semibold">Advances · Table 11A / 11B</h2>
          {m.advances.received.length + m.advances.adjusted.length === 0 ? (
            <EmptyState>No advances this month.</EmptyState>
          ) : (
            <Table columns="0.5fr 1fr 0.8fr 1fr 1fr" minWidth={480}>
              <Row head>
                <span>Table</span>
                <span>Receipt · proforma</span>
                <span>Event</span>
                <span className="text-right">Amount</span>
                <span className="text-right">Tax</span>
              </Row>
              {[
                ...m.advances.received.map((a) => ({ a, t: '11A' })),
                ...m.advances.adjusted.map((a) => ({ a, t: '11B' })),
              ].map(({ a, t }) => (
                <Row key={`${t}-${a.receiptNumber}-${a.event}`}>
                  <span>{t}</span>
                  <span className="truncate font-mono text-[11.5px]">
                    {a.receiptNumber} · {a.proformaNumber}
                  </span>
                  <span className="text-muted">{a.event}</span>
                  <span className="num text-right">{rupees(a.amount)}</span>
                  <span className="num text-right">
                    {rupees(t === '11B' ? -total(a.tax) : total(a.tax))}
                  </span>
                </Row>
              ))}
            </Table>
          )}
        </div>
      </section>
      <ItcRegister m={m} />
    </div>
  );
}

function Summary3B({ m }: { m: GstMonth }) {
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">GSTR-3B summary</h2>
      <Table columns="2.4fr 1fr 1fr 1fr 1fr" minWidth={760}>
        <Row head>
          <span>Section</span>
          <span className="text-right">Taxable</span>
          <span className="text-right">IGST</span>
          <span className="text-right">CGST</span>
          <span className="text-right">SGST</span>
        </Row>
        <Row>
          <span>3.1(a) Outward supplies, net of credit notes</span>
          <span className="num text-right">{rupees(m.outward.taxable)}</span>
          <TaxCells t={m.outward.tax} />
        </Row>
        <Row>
          <span>3.1(a) Advances received (11A) less adjusted (11B)</span>
          <span className="num text-right">
            {rupees(m.advancesReceived.taxable - m.advancesAdjusted.taxable)}
          </span>
          <TaxCells t={addHeads(m.advancesReceived.tax, m.advancesAdjusted.tax, -1)} />
        </Row>
        <Row>
          <span>4(A)(5) Input tax credit this month</span>
          <span />
          <TaxCells t={m.itc} />
        </Row>
        <Row>
          <span>Credit brought forward</span>
          <span />
          <TaxCells t={m.openingCredit} />
        </Row>
        <Row>
          <span className="font-semibold">6.1 Tax payable in cash</span>
          <span />
          <TaxCells t={m.setOff.cash} />
        </Row>
      </Table>
    </section>
  );
}

function Gstr1Documents({ m }: { m: GstMonth }) {
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">GSTR-1 · invoices and credit notes</h2>
      {m.invoices.length + m.creditNotes.length === 0 ? (
        <EmptyState>No outward supplies this month.</EmptyState>
      ) : (
        <Table columns="1.1fr 0.8fr 0.6fr 1.3fr 0.5fr 0.5fr 1fr 0.9fr 0.9fr 0.9fr" minWidth={1120}>
          <Row head>
            <span>Number</span>
            <span>Date</span>
            <span>Type</span>
            <span>GSTIN</span>
            <span>POS</span>
            <span>Rate</span>
            <span className="text-right">Taxable</span>
            <span className="text-right">IGST</span>
            <span className="text-right">CGST</span>
            <span className="text-right">SGST</span>
          </Row>
          {[
            ...m.invoices.map((d) => ({ d, cn: false })),
            ...m.creditNotes.map((d) => ({ d, cn: true })),
          ].flatMap(({ d, cn }) =>
            d.items.map((it) => (
              <Row key={`${d.number}-${it.rate}`}>
                <span className="font-mono text-[12px]">{d.number}</span>
                <span className="text-muted">{formatDate(d.date)}</span>
                <span>
                  <Pill tone={cn ? 'red' : d.ctin ? 'blue' : 'grey'}>
                    {cn ? 'CN' : d.ctin ? 'B2B' : 'B2C'}
                  </Pill>
                </span>
                <span className="truncate font-mono text-[11.5px] text-muted">{d.ctin ?? '—'}</span>
                <span>{d.pos}</span>
                <span>{it.rate}%</span>
                <span className="num text-right">{rupees(cn ? -it.taxable : it.taxable)}</span>
                <TaxCells t={cn ? addHeads({ igst: 0, cgst: 0, sgst: 0 }, it.tax, -1) : it.tax} />
              </Row>
            )),
          )}
        </Table>
      )}
    </section>
  );
}

function ItcRegister({ m }: { m: GstMonth }) {
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">ITC register</h2>
      {m.itcRegister.length === 0 ? (
        <EmptyState>No purchase bills this month.</EmptyState>
      ) : (
        <Table columns="0.9fr 0.8fr 1.6fr 1.3fr 1fr 1fr 0.9fr" minWidth={960}>
          <Row head>
            <span>Bill no</span>
            <span>Date</span>
            <span>Vendor</span>
            <span>GSTIN</span>
            <span className="text-right">Taxable</span>
            <span className="text-right">GST</span>
            <span>ITC</span>
          </Row>
          {m.itcRegister.map((b) => (
            <Row key={b.billId}>
              <span className="font-mono text-[12px]">{b.billNo}</span>
              <span className="text-muted">{formatDate(b.billDate)}</span>
              <span className="truncate">{b.vendorName}</span>
              <span className="truncate font-mono text-[11.5px] text-muted">
                {b.vendorGstin ?? 'Unregistered'}
              </span>
              <span className="num text-right">{rupees(b.taxable)}</span>
              <span className="num text-right">{rupees(total(b.tax))}</span>
              <span>
                <Pill tone={b.eligible ? 'green' : 'grey'}>
                  {b.eligible ? 'Eligible' : 'No ITC'}
                </Pill>
              </span>
            </Row>
          ))}
        </Table>
      )}
    </section>
  );
}
