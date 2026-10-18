import { z } from 'zod';
import { api } from '@/lib/http';
import { printHeader } from '@/lib/letterhead';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';
import { statementPdfResponse } from '@/pdf/responses';

const query = z.object({ from: z.string().optional(), to: z.string().optional() });

/** A client's statement of account as a PDF (default: this financial year to date); audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params, req }) => {
  const range = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const st = await services().outstanding.statement(actor, params.id, range);
  await services().audit.recordDocumentPdf(actor, {
    module: 'outstanding',
    entity: 'client_statement',
    entityId: st.client.id,
    number: `${st.from}..${st.to}`,
  });
  return statementPdfResponse(st, await printHeader(actor));
});
