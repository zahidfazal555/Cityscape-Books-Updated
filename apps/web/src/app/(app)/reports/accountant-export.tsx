import { Button, Input } from '@/components/ui';

/**
 * "Export for accountant": the period's books as a ZIP of plain CSV files. A plain GET form, so the
 * browser downloads the file. Shown to the owner and the auditor (CA), whom the service allows.
 */
export function AccountantExport({ from, to }: { from: string; to: string }) {
  return (
    <section data-noprint className="rounded-lg border border-line bg-white p-4">
      <h2 className="mb-1 text-[15px] font-semibold">Export for accountant</h2>
      <p className="mb-3 text-[13px] text-muted">
        One ZIP of CSV files for the period: day book (every journal entry), trial balance, sales
        invoices, credit notes, receipts, purchase bills, vendor payments, expenses, payroll and the
        chart of accounts.
      </p>
      <form
        method="get"
        action="/api/v1/reports/accountant-export"
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-[13px] font-medium text-body">
          From
          <Input type="date" name="from" defaultValue={from} required />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-body">
          To
          <Input type="date" name="to" defaultValue={to} required />
        </label>
        <Button type="submit">Download ZIP</Button>
      </form>
    </section>
  );
}
