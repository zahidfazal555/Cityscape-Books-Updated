import { apiUpload } from '@/lib/http';
import { services } from '@/lib/server';

/** Bill photo upload: the raw file as the body (JPEG, PNG or PDF, ≤ 10 MB). */
export const POST = apiUpload(async ({ actor, file }) =>
  services().attachments.upload(actor, file),
);
