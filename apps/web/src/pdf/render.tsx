import 'server-only';
import type { ReactElement } from 'react';
import { NextResponse } from 'next/server';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';

/** A PDF download. The caller has read the data with the user's rights and audited it (H4). */
export async function pdfResponse(
  filename: string,
  doc: ReactElement<DocumentProps>,
): Promise<NextResponse> {
  const pdf = await renderToBuffer(doc);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
