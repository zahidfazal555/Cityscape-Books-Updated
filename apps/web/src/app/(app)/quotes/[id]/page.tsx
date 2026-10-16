import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { A4Document, placeOfSupply } from '@/components/sales/a4-document';
import { rupees } from '@/lib/format';
import { loadOr404 } from '@/lib/not-found';
import { PROFORMA_STATUS, QUOTE_STATUS } from '@/lib/sales';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { QuoteActions } from './quote-actions';

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  const { id } = await params;
  const q = await loadOr404(id, () => services().quotations.get(actor, id));
  const letterhead = await services().settings.letterhead(actor);
  const scope = q.projectId ?? undefined;
  const canEdit = can(actor, 'quotes', 'edit', scope);
  const clients =
    canEdit && q.status === 'draft' && can(actor, 'contacts', 'view')
      ? await services().contacts.list(actor, 'client')
      : [];
  const client = await services()
    .contacts.get(actor, q.clientId)
    .catch(() => null);
  const status = QUOTE_STATUS[q.status];
  return (
    <div className="flex flex-col gap-4">
      <div data-noprint className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/quotes" className="text-[13px] text-muted hover:text-primary">
            ← Quotations
          </Link>
          <Pill tone={status.tone}>{status.label}</Pill>
          {q.revision > 0 ? (
            <span className="text-[13px] text-muted">Revision {q.revision}</span>
          ) : null}
        </div>
        <QuoteActions
          quote={q}
          rights={{
            edit: canEdit,
            full: can(actor, 'quotes', 'full', scope),
            approve: can(actor, 'approvals', 'full'),
            proforma: q.projectId !== null && can(actor, 'proformas', 'edit', q.projectId),
            invoice: q.projectId !== null && can(actor, 'invoices', 'edit', q.projectId),
            projects: can(actor, 'projects', 'edit'),
          }}
          clients={clients.map((c) => ({ id: c.id, name: c.name, stateCode: c.stateCode }))}
          companyStateCode={letterhead.stateCode}
        />
      </div>
      {q.discountPct > 0 && !q.discountApproved ? (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
          The {q.discountPct}% discount is waiting for the owner&apos;s approval. The quotation
          cannot be sent until then.
        </p>
      ) : null}
      <A4Document
        title={q.revision > 0 ? `QUOTATION · R${q.revision}` : 'QUOTATION'}
        number={q.number}
        letterhead={letterhead}
        billTo={{
          name: q.clientName,
          gstin: client?.gstin ?? null,
          address: client?.address ?? null,
        }}
        meta={[
          ['Quote date', formatDate(q.quoteDate)],
          ['Valid till', formatDate(q.validTill)],
          ['Place of supply', placeOfSupply(q.placeOfSupply)],
          ['Proposal', q.title],
          ...(q.site ? ([['Site', q.site]] as [string, string][]) : []),
        ]}
        lines={q.lines.map((l, i) => ({ ...l, amount: q.totals.lines[i]?.amount ?? 0 }))}
        totals={q.totals}
        discountPct={q.discountPct}
        interState={q.totals.interState}
        showBank={false}
        footer={
          q.terms ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
                Terms
              </div>
              <p className="whitespace-pre-line">{q.terms}</p>
            </div>
          ) : null
        }
      />
      <section data-noprint className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-white p-4 text-[13px]">
          <h2 className="mb-2 font-semibold">Linked documents</h2>
          {q.projectId ? (
            <p>
              Project{' '}
              <Link href={`/projects/${q.projectId}`} className="font-mono text-primary">
                {q.projectCode}
              </Link>
            </p>
          ) : (
            <p className="text-muted">No project yet.</p>
          )}
          {q.proformas.map((p) => (
            <p key={p.id}>
              Proforma{' '}
              <Link href={`/proformas/${p.id}`} className="font-mono text-primary">
                {p.number}
              </Link>{' '}
              · {rupees(p.total)} ·{' '}
              {PROFORMA_STATUS[p.status as keyof typeof PROFORMA_STATUS]?.label ?? p.status}
            </p>
          ))}
          {q.invoices.map((i) => (
            <p key={i.id}>
              Tax invoice{' '}
              <Link href={`/invoices/${i.id}`} className="font-mono text-primary">
                {i.number}
              </Link>{' '}
              · {rupees(i.total)}
            </p>
          ))}
        </div>
        <div className="rounded-lg border border-line bg-white p-4 text-[13px]">
          <h2 className="mb-2 font-semibold">Revision history</h2>
          {q.revisions.length === 0 ? (
            <p className="text-muted">No revisions.</p>
          ) : (
            q.revisions.map((r) => (
              <p key={r.revision} className="flex justify-between gap-3">
                <span>
                  R{r.revision} · {formatDate(r.quoteDate)} ·{' '}
                  {QUOTE_STATUS[r.status as keyof typeof QUOTE_STATUS]?.label ?? r.status}
                </span>
                <span className="num">{rupees(r.total)}</span>
              </p>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
