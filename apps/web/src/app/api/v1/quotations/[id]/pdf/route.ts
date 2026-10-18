import { quoteSpec } from '@/lib/documents';
import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { a4PdfResponse } from '@/pdf/responses';

/** Quotation as an A4 PDF (FR-3.4.5); drafts carry the DRAFT watermark. Audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const q = await services().quotations.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'quotes',
    entity: 'quotation',
    entityId: q.id,
    number: q.number,
  });
  return a4PdfResponse(quoteSpec(q), letterhead);
});
