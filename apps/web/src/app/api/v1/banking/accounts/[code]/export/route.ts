import { z } from 'zod';
import { formatDate, toDecimalString } from '@csd/core';
import { MONEY_ACCOUNTS, type MoneyAccount } from '@csd/services';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Chart of accounts names (migration 0001). */
const REGISTER_TITLE: Record<MoneyAccount, string> = {
  '1000': 'Cash in hand',
  '1010': 'Bank – current account',
  '1020': 'UPI clearing',
};
const query = z
  .object({ from: z.string().optional(), to: z.string().optional() })
  .merge(exportFormat);

/** The register as CSV or PDF; the export is audited (H4). */
export const GET = api<{ code: string }>(async ({ actor, params, req }) => {
  const code = input(z.enum(MONEY_ACCOUNTS), params.code) as MoneyAccount;
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const reg = await services().banking.register(actor, code, q);
  await services().reports.recordExport(actor, 'bank-register', reg.lines.length, q.format);
  return exportResponse(
    actor,
    q.format,
    `register-${code}-${reg.from}-${reg.to}`,
    {
      title: `${REGISTER_TITLE[code]} register`,
      subtitle: `${formatDate(reg.from)} to ${formatDate(reg.to)}`,
    },
    [
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
    ],
  );
});
