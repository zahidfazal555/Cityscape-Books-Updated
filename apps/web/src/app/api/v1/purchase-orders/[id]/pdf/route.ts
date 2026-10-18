import { poSpec } from '@/lib/documents';
import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { a4PdfResponse } from '@/pdf/responses';

/** Purchase order as an A4 PDF (FR-3.4.5); drafts and cancelled POs are watermarked. Audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const po = await services().purchaseOrders.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'pos',
    entity: 'purchase_order',
    entityId: po.id,
    number: po.number,
  });
  return a4PdfResponse(poSpec(po), letterhead);
});
