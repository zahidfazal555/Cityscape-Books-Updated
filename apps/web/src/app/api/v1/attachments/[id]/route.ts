import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/**
 * The photo, for someone who may see its expense; every view is audited (H4). Images are shown
 * inline in a sandboxed, script-free document. PDFs are not cleaned or rendered by the app, so
 * they are always a download (BUG-107), never opened inside the app's origin.
 */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const f = await services().attachments.read(actor, params.id);
  const pdf = f.contentType === 'application/pdf';
  return new NextResponse(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.contentType,
      'content-disposition': pdf ? `attachment; filename="bill-${params.id}.pdf"` : 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
    },
  });
});
