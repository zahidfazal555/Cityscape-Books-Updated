import { formatDocNumber, seriesPeriod, type IsoDate, type Series } from '@csd/core';
import type pg from 'pg';

/**
 * Allocates the next gapless number for a series. Must run inside the transaction that
 * inserts the document (use with `withTenant`); a rollback gives the number back.
 */
export async function allocateNumber(
  client: pg.PoolClient,
  series: Series,
  docDate: IsoDate,
  fyStartMonth = 4,
): Promise<string> {
  const period = seriesPeriod(series, docDate, fyStartMonth);
  const { rows } = await client.query<{ n: number }>('SELECT next_number($1, $2) AS n', [
    series,
    period,
  ]);
  const n = rows[0]?.n;
  if (n === undefined) throw new Error('number_series returned no value');
  return formatDocNumber(series, period, n);
}
