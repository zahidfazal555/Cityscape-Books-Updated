'use client';

import { useEffect, useState } from 'react';

/**
 * False until React has hydrated. Forms keep their submit button disabled until then, so an
 * early Enter can never fall back to a native submit that puts a password in the URL.
 */
export function useHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
