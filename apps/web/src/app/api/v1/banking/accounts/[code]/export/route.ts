import { z } from 'zod';
import { toDecimalString } from '@csd/core';
import { MONEY_ACCOUNTS, type MoneyAccount } from '@csd/services';
import { csvResponse } from '@/lib/csv-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ from: z.string().optional(), to: z.string().optional() });

/** The register as CSV; the export is audited (H4). */
export const GET = api<{ code: string }>(async ({ actor, params, req }) => {
  const code = input(z.enum(MONEY_ACCOUNTS), params.code) as MoneyAccount;
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const reg = await services().banking.register(actor, code, q);
  await services().reports.recordExport(actor, 'bank-register', reg.lines.length);
  return csvResponse(`register-${code}-${reg.from}-${reg.to}`, [
    ['Date', 'Particulars', 'Project', 'Mode', 'Money in', 'Money out', 'Balance', 'Matched'],
    ['', 'Opening balance', '', '', '', '', toDecimalString(reg.opening), ''],
    ...reg.lines.map((l) => [
      l.date,
      l.particulars,
      l.projectCode ?? '',
      l.mode ?? '',
      l.moneyIn ? toDecimalString(l.moneyIn) : '',
      l.moneyOut ? toDecimalString(l.moneyOut) : '',
      toDecimalString(l.balance),
      l.reversed ? 'reversed' : l.matched ? 'yes' : 'no',
    ]),
  ]);
});
