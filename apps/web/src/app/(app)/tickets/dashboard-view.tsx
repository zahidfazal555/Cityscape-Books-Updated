import { SLA_HOURS, TICKET_PRIORITIES } from '@csd/core';
import type { SupportDashboard } from '@csd/services';
import { Row, Table } from '@/components/kit';
import { Cards } from '@/components/sales/filter-chips';
import { rupees } from '@/lib/format';
import { PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL } from '@/lib/support';

const hours = (h: number | null) =>
  h === null ? '—' : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
const pct = (p: number | null) => (p === null ? '—' : `${p}%`);

function Bars({
  title,
  rows,
  label,
}: {
  title: string;
  rows: { key: string; count: number }[];
  label: (k: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h3 className="mb-3 text-[14px] font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="text-[13px] text-muted">No tickets yet.</p> : null}
      <ul className="flex flex-col gap-2 text-[13px]">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
            <span className="truncate">{label(r.key)}</span>
            <span className="h-2 overflow-hidden rounded-full bg-track">
              <span
                className="block h-full bg-primary"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </span>
            <span className="num w-8 text-right">{r.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Support dashboard (FR-19.12). */
export function SupportDashboardView({ d }: { d: SupportDashboard }) {
  return (
    <div className="flex flex-col gap-4">
      <Cards
        items={[
          ['Average first response', hours(d.avgFirstResponseHours)],
          ['Average resolution', hours(d.avgResolutionHours)],
          ['Response SLA met', pct(d.responseSlaMetPct)],
          ['Resolution SLA met', pct(d.resolutionSlaMetPct)],
          ['Customer rating', d.avgRating === null ? '—' : `${d.avgRating} / 5`],
          [
            'Service cost charged to projects',
            `${rupees(d.serviceCost.approved)}${d.serviceCost.pending > 0 ? ` (+${rupees(d.serviceCost.pending)} pending)` : ''}`,
          ],
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Bars
          title="By type"
          rows={d.byType}
          label={(k) => TYPE_LABEL[k as keyof typeof TYPE_LABEL] ?? k}
        />
        <Bars
          title="By status"
          rows={d.byStatus}
          label={(k) => STATUS_LABEL[k as keyof typeof STATUS_LABEL] ?? k}
        />
        <Bars title="By project" rows={d.byProject} label={(k) => k} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-[14px] font-semibold">Team workload</h3>
          <Table columns="1.5fr 0.7fr 0.8fr 0.8fr 0.8fr" minWidth={480}>
            <Row head>
              <span>Handler</span>
              <span className="text-right">Open</span>
              <span className="text-right">Resolved</span>
              <span className="text-right">Breached</span>
              <span className="text-right">Rating</span>
            </Row>
            {d.workload.map((w) => (
              <Row key={w.name}>
                <span>{w.name}</span>
                <span className="num text-right">{w.open}</span>
                <span className="num text-right">{w.resolved}</span>
                <span className="num text-right">{w.breached}</span>
                <span className="num text-right">{w.avgRating ?? '—'}</span>
              </Row>
            ))}
          </Table>
        </section>
        <section>
          <h3 className="mb-2 text-[14px] font-semibold">SLA targets</h3>
          <Table columns="1fr 1fr 1fr" minWidth={360}>
            <Row head>
              <span>Priority</span>
              <span className="text-right">First response</span>
              <span className="text-right">Resolution</span>
            </Row>
            {TICKET_PRIORITIES.map((p) => (
              <Row key={p}>
                <span>{PRIORITY_LABEL[p]}</span>
                <span className="num text-right">{hours(SLA_HOURS[p].response)}</span>
                <span className="num text-right">{hours(SLA_HOURS[p].resolution)}</span>
              </Row>
            ))}
          </Table>
        </section>
      </div>
    </div>
  );
}
