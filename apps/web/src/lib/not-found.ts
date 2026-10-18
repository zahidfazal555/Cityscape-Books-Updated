import 'server-only';
import { notFound } from 'next/navigation';
import { DomainError, isUuid } from '@csd/core';

/** Loads a record for a detail page; a bad id, 404 or 403 renders the not-found page. */
export async function loadOr404<T>(id: string, load: () => Promise<T>): Promise<T> {
  if (!isUuid(id)) notFound();
  return load().catch((e: unknown) => {
    if (e instanceof DomainError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  });
}
