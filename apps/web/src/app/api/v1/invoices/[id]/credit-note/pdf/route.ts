import { DomainError } from '@csd/core';
import { creditNoteSpec } from '@/lib/documents';
import { api } from '@/lib/http';
import { services } from '@/lib/server';
import { a4PdfResponse } from '@/pdf/responses';

/** The credit note that cancelled this invoice (FR-7.4) as an A4 PDF; audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const inv = await services().invoices.get(actor, params.id);
  const spec = creditNoteSpec(inv);
  if (!spec) throw new DomainError('NOT_FOUND', 'This invoice has no credit note.');
  const letterhead = await services().settings.letterhead(actor);
  await services().audit.recordDocumentPdf(actor, {
    module: 'invoices',
    entity: 'credit_note',
    entityId: inv.id,
    number: spec.number,
  });
  return a4PdfResponse(spec, letterhead);
});
