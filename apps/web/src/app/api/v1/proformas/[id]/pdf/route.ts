import { proformaSpec } from '@/lib/documents';
import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { a4PdfResponse } from '@/pdf/responses';

/** Proforma invoice as an A4 PDF (FR-3.4.5); audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const pf = await services().proformas.get(actor, params.id);
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'proformas',
    entity: 'proforma',
    entityId: pf.id,
    number: pf.number,
  });
  return a4PdfResponse(proformaSpec(pf), letterhead);
});
