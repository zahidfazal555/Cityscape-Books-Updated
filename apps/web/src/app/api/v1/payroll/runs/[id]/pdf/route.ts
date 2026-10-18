import { z } from 'zod';
import { DomainError } from '@csd/core';
import { api } from '@/lib/http';
import { printHeader } from '@/lib/letterhead';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';
import { payslipsPdfResponse } from '@/pdf/responses';

const query = z.object({ employee: z.string().uuid().optional() });

/**
 * Payslips of a run as a PDF, one page each, or one employee's (`?employee=`). Reading the run is
 * the audited payslip view (H4); the download is audited too.
 */
export const GET = api<{ id: string }>(async ({ actor, params, req }) => {
  const { employee } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const run = await services().payroll.run(actor, params.id);
  const only = employee ? run.lines.find((l) => l.employeeId === employee) : undefined;
  if (employee && !only) {
    throw new DomainError('NOT_FOUND', 'No payslip for this employee in the run.');
  }
  await services().audit.recordDocumentPdf(actor, {
    module: 'payroll',
    entity: 'payroll_run',
    entityId: run.id,
    number: only ? `${run.period} · ${only.name}` : run.period,
  });
  return payslipsPdfResponse(run, await printHeader(actor), only);
});
