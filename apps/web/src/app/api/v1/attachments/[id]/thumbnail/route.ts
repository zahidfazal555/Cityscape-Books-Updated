import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The card preview of a bill photo: same access rule as the photo, not audited (BUG-110). */
export const GET = api<{ id: string }>(async ({ actor, params }) => {
  const f = await services().attachments.thumbnail(actor, params.id);
  return new NextResponse(new Uint8Array(f.bytes), {
    headers: {
      'content-type': f.contentType,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});
