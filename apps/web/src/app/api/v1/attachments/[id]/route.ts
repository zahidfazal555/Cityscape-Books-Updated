import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The photo, for someone who may see its expense; every view is audited (H4). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const f = await services().attachments.read(actor, params.id);
  return new NextResponse(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.contentType,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      // A PDF opened inline must not run scripts or reach anything.
      'content-security-policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
