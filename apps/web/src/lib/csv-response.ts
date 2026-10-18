import 'server-only';
import { NextResponse } from 'next/server';
import { toCsv } from './sales';

/** A CSV download (the caller has already written the export's audit row, H4). */
export function csvResponse(
  name: string,
  rows: readonly (readonly (string | number)[])[],
): NextResponse {
  return new NextResponse(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}.csv"`,
    },
  });
}
