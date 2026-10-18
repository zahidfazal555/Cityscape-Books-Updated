import 'server-only';
import { z } from 'zod';
import { DomainError, type Actor } from '@csd/core';
import type { ExportFormat } from '@csd/services';
import { tablePdfResponse } from '@/pdf/responses';
import { csvResponse } from './csv-response';
import { printHeader } from './letterhead';

/** `?format=csv|pdf` on every export route (FR-3.4.5, Tech Spec §11). CSV stays the default. */
/** react-pdf lays out in the request: past this a PDF is unreadable anyway, and slow to build. */
export const PDF_MAX_ROWS = 2000;

export const exportFormat = z.object({ format: z.enum(['csv', 'pdf']).default('csv') });

/**
 * The same rows as CSV or as a PDF table. The caller has already read the data with the user's
 * rights and written the export's audit row with this format (H4).
 */
export async function exportResponse(
  actor: Actor,
  format: ExportFormat,
  name: string,
  table: { title: string; subtitle?: string | undefined },
  rows: readonly (readonly (string | number)[])[],
): Promise<Response> {
  if (format === 'csv') return csvResponse(name, rows);
  if (rows.length - 1 > PDF_MAX_ROWS) {
    throw new DomainError(
      'VALIDATION',
      `More than ${PDF_MAX_ROWS.toLocaleString('en-IN')} rows for a PDF. Filter the list first, or use CSV.`,
      'format',
    );
  }
  return tablePdfResponse(name, { ...table, rows }, await printHeader(actor));
}
