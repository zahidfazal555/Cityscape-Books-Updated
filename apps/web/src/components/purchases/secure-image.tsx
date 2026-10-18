'use client';

import { useEffect, useState } from 'react';
import { apiBlob } from '@/lib/client';

/** Loads a private image with the session (refreshing it if needed) and shows it from memory. */
export function SecureImage({
  src,
  alt,
  className,
  fallback,
}: {
  src: string;
  alt: string;
  className?: string;
  fallback: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    apiBlob(src)
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  if (failed) return <span className="text-[12px] text-muted">{fallback}</span>;
  if (!url) return <span className="text-[12px] text-subtle">Loading…</span>;
  return <img src={url} alt={alt} className={className} />;
}
