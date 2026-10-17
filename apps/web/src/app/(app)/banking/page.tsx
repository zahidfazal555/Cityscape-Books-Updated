import Link from 'next/link';
import { can, formatDate, projectScope } from '@csd/core';
import { MONEY_ACCOUNTS, type MoneyAccount } from '@csd/services';
import { PageHeader, Row, Table } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { MatchBox, OpeningBalance } from './banking-actions';

export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'banking', 'view') || projectScope(actor) !== null)
    return (
      <EmptyState>Cash, bank & UPI needs banking rights and access to all projects.</EmptyState>
    );
  const q = await searchParams;
  const code = (MONEY_ACCOUNTS.find((a) => a === q.account) ?? '1010') as MoneyAccount;
  const range = { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) };
  const [cards, register, staff] = await Promise.all([
    services().banking.accounts(actor),
    services().banking.register(actor, code, range),
    services().banking.spendByStaff(actor, range),
  ]);
  const canMatch = can(actor, 'banking', 'edit');
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Cash, bank & UPI"
        subtitle="Registers straight from the books. Tick each line once it appears on the statement."
        action={actor.role === 'owner' ? <OpeningBalance code={code} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.code}
            href={`/banking?account=${c.code}`}
            aria-current={c.code === code ? 'true' : undefined}
            className={`rounded-lg border bg-white p-4 ${c.code === code ? 'border-primary ring-2 ring-primary-tint' : 'border-line'}`}
          >
            <div className="text-[13px] text-muted">{c.name}</div>
            <div className="num text-[22px] font-semibold">{rupees(c.balance)}</div>
            <div className="text-xs text-subtle">{c.unmatched} not yet matched</div>
          </Link>
        ))}
      </div>
      <form className="flex flex-wrap items-end gap-3 text-[12px] text-muted" data-noprint>
        <input type="hidden" name="account" value={code} />
        <label className="flex flex-col gap-1">
          From
          <input
            type="date"
            name="from"
            defaultValue={register.from}
            className="h-9 rounded-md border border-input px-2 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          To
          <input
            type="date"
            name="to"
            defaultValue={register.to}
            className="h-9 rounded-md border border-input px-2 text-[13px]"
          />
        </label>
        <button
          type="submit"
          className="h-9 rounded-md border border-input bg-white px-4 text-[13px] font-medium text-primary"
        >
          Show
        </button>
        <p className="ml-auto text-[13px]" data-testid="unmatched">
          {register.unmatched} {register.unmatched === 1 ? 'entry' : 'entries'} not yet matched with
          the statement
        </p>
      </form>
      {register.truncated ? (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
          Showing the first {register.lines.length.toLocaleString('en-IN')} lines. Choose a shorter
          range to see the rest; the closing balance includes every line.
        </p>
      ) : null}
      {register.lines.length === 0 ? (
        <EmptyState>No entries in this period.</EmptyState>
      ) : (
        <Table columns="48px 0.8fr 2.4fr 0.8fr 0.7fr 1fr 1fr 1.1fr" minWidth={1000}>
          <Row head>
            <span>Rec.</span>
            <span>Date</span>
            <span>Particulars</span>
            <span>Project</span>
            <span>Mode</span>
            <span className="text-right">Money in</span>
            <span className="text-right">Money out</span>
            <span className="text-right">Balance</span>
          </Row>
          <Row>
            <span />
            <span className="text-muted">{formatDate(register.from)}</span>
            <span className="font-medium">Opening balance</span>
            <span />
            <span />
            <span />
            <span />
            <span className="num text-right font-medium">{rupees(register.opening)}</span>
          </Row>
          {register.lines.map((l) => (
            <Row key={l.lineId}>
              <span>
                {l.reversed ? (
                  <span className="text-xs text-subtle" title="Reversed entry: needs no match">
                    —
                  </span>
                ) : (
                  <MatchBox lineId={l.lineId} matched={l.matched} disabled={!canMatch} />
                )}
              </span>
              <span className="text-muted">{formatDate(l.date)}</span>
              <span className={`truncate ${l.reversed ? 'text-subtle line-through' : ''}`}>
                {l.particulars}
              </span>
              <span className="text-muted">{l.projectCode ?? '—'}</span>
              <span className="text-muted">{l.mode ?? '—'}</span>
              <span className="num text-right">{l.moneyIn ? rupees(l.moneyIn) : ''}</span>
              <span className="num text-right">{l.moneyOut ? rupees(l.moneyOut) : ''}</span>
              <span className="num text-right">{rupees(l.balance)}</span>
            </Row>
          ))}
        </Table>
      )}
      <p className="text-right text-[13px]">
        Closing balance <span className="num font-semibold">{rupees(register.closing)}</span>
      </p>
      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Spending by staff</h2>
        {staff.length === 0 ? (
          <EmptyState>No approved spending in this period.</EmptyState>
        ) : (
          <Table columns="1.6fr 1fr 1fr 1fr 1fr" minWidth={640}>
            <Row head>
              <span>Paid by</span>
              <span className="text-right">UPI</span>
              <span className="text-right">Cash</span>
              <span className="text-right">Bank</span>
              <span className="text-right">Total</span>
            </Row>
            {staff.map((s) => (
              <Row key={s.paidBy}>
                <span>{s.paidBy}</span>
                <span className="num text-right">{rupees(s.upi)}</span>
                <span className="num text-right">{rupees(s.cash)}</span>
                <span className="num text-right">{rupees(s.bank)}</span>
                <span className="num text-right font-medium">{rupees(s.total)}</span>
              </Row>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
