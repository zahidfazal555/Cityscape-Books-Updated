import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { billPdfResponse } from '@/pdf/responses';

/** A purchase bill as recorded, as a PDF; audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const b = await services().bills.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'bills',
    entity: 'bill',
    entityId: b.id,
    number: b.billNo,
  });
  return billPdfResponse(b, letterhead);
});
