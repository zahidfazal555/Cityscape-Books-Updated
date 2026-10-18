import { invoiceSpec } from '@/lib/documents';
import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { a4PdfResponse } from '@/pdf/responses';

/** Tax invoice as an A4 PDF (FR-3.4.5); the download is audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const inv = await services().invoices.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'invoices',
    entity: 'invoice',
    entityId: inv.id,
    number: inv.number,
  });
  return a4PdfResponse(invoiceSpec(inv), letterhead);
});
