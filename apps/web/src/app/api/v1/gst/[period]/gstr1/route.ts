import { NextResponse } from 'next/server';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** GSTR-1 JSON for the GST offline tool (FR-15.6); the download is audited (H4). */
export const GET = api<{ period: string }>(async ({ actor, params }) => {
  const json = await services().gst.gstr1Json(actor, params.period);
  return new NextResponse(JSON.stringify(json, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="GSTR1-${json.fp}.json"`,
    },
  });
});
