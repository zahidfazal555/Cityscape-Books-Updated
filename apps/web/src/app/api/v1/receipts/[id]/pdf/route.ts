import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { receiptPdfResponse } from '@/pdf/responses';

/** A client receipt as a PDF, for the client's records; audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const r = await services().receipts.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'receipts',
    entity: 'receipt',
    entityId: r.id,
    number: r.number,
  });
  return receiptPdfResponse(r, letterhead);
});
