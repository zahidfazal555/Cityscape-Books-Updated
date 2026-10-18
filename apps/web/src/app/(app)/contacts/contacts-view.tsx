'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Contact, ContactType } from '@csd/services';
import { Button, EmptyState, Input } from '@/components/ui';
import { PageHeader, Row, Table } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';
import { ContactDrawer } from './contact-drawer';

export function ContactsView({
  type,
  q,
  contacts,
  canEdit,
  canArchive,
  canStatement,
}: {
  type: ContactType;
  q: string;
  contacts: Contact[];
  canEdit: boolean;
  canArchive: boolean;
  /** A client's statement of account (PDF), for users who can see outstanding. */
  canStatement: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noun = type === 'client' ? 'client' : 'vendor';

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('q') ?? '');
    router.push(`/contacts?tab=${type}${value ? `&q=${encodeURIComponent(value)}` : ''}`);
  }

  async function archive(c: Contact) {
    if (!window.confirm(`Archive ${c.name}? It will no longer appear in lists or pickers.`)) return;
    setError(null);
    try {
      await apiFetch(`/api/v1/contacts/${c.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not archive.');
    }
  }

  return (
    <>
      <PageHeader
        title="Clients & vendors"
        action={canEdit ? <Button onClick={() => setEditing('new')}>+ Add {noun}</Button> : null}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <nav aria-label="Contact type" className="flex gap-1.5">
          {(['client', 'vendor'] as const).map((t) => (
            <Link
              key={t}
              href={`/contacts?tab=${t}`}
              aria-current={t === type ? 'true' : undefined}
              className={`h-[30px] rounded-[15px] border px-3 text-[13px] leading-[28px] ${
                t === type
                  ? 'border-primary bg-primary-tint font-medium text-primary'
                  : 'border-input bg-white text-body'
              }`}
            >
              {t === 'client' ? 'Clients' : 'Vendors'}
            </Link>
          ))}
        </nav>
        <form method="get" onSubmit={search} className="ml-auto flex gap-2" role="search">
          <label htmlFor="q" className="sr-only">
            Search by name or GSTIN
          </label>
          <Input id="q" name="q" defaultValue={q} placeholder="Search by name or GSTIN" />
          <Button variant="ghost" type="submit">
            Search
          </Button>
        </form>
      </div>
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {contacts.length === 0 ? (
        <EmptyState>{q ? `No ${noun}s match “${q}”.` : `No ${noun}s yet.`}</EmptyState>
      ) : (
        <Table columns="2.2fr 1.5fr 1.2fr 1fr 0.8fr 1.2fr" minWidth={900}>
          <Row head>
            <span>Name · contact</span>
            <span>GSTIN</span>
            <span>State</span>
            <span>Phone</span>
            <span className="text-right">{type === 'client' ? 'Projects' : 'PAN'}</span>
            <span />
          </Row>
          {contacts.map((c) => (
            <Row key={c.id}>
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block truncate text-xs text-muted">{c.contactPerson ?? ''}</span>
              </span>
              <span className="font-mono text-[11.5px]">
                {c.gstin ?? <span className="text-subtle">Unregistered</span>}
              </span>
              <span>
                {c.state} <span className="text-muted">({c.stateCode})</span>
              </span>
              <span className="num text-muted">{c.phone ?? '—'}</span>
              <span className="num text-right">
                {type === 'client' ? c.projectCount : (c.pan ?? '—')}
              </span>
              <span className="flex items-center justify-end gap-1.5">
                {canStatement ? (
                  <a
                    href={`/api/v1/contacts/${c.id}/statement/pdf`}
                    title="Statement of account, this financial year to date (PDF)"
                    className="inline-flex h-[26px] items-center rounded-md border border-input bg-white px-2 text-xs font-medium text-primary hover:bg-thead"
                  >
                    Statement
                  </a>
                ) : null}
                {canEdit ? (
                  <Button
                    variant="ghost"
                    className="h-[26px] px-2 text-xs"
                    onClick={() => setEditing(c)}
                  >
                    Edit
                  </Button>
                ) : null}
                {canArchive ? (
                  <Button
                    variant="ghost"
                    className="h-[26px] px-2 text-xs"
                    onClick={() => archive(c)}
                  >
                    Archive
                  </Button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
      {editing ? (
        <ContactDrawer
          type={type}
          contact={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
