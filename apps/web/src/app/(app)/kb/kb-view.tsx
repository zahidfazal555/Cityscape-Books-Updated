'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { KbArticle, KbCategory, ReplyTemplate } from '@csd/services';
import { Button, EmptyState, Field, FormError, Input } from '@/components/ui';
import { Drawer, Pill } from '@/components/kit';
import { selectCls, textareaCls, useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { KB_CATEGORY_LABEL } from '@/lib/support';

type Editing =
  | { kind: 'article'; item: KbArticle | null }
  | { kind: 'template'; item: ReplyTemplate | null }
  | null;

export function KbView({
  tab,
  articles,
  templates,
  rights,
}: {
  tab: 'guides' | 'templates';
  articles: KbArticle[];
  templates: ReplyTemplate[];
  rights: { edit: boolean; full: boolean };
}) {
  const [reading, setReading] = useState<KbArticle | null>(articles[0] ?? null);
  const [editing, setEditing] = useState<Editing>(null);
  const remove = useAction();
  const del = (kind: 'articles' | 'templates', id: string) =>
    window.confirm('Delete this for everyone?') &&
    void remove.run(() => apiFetch(`/api/v1/kb/${kind}/${id}`, { method: 'DELETE' }));
  return (
    <div className="flex flex-col gap-3">
      {rights.edit ? (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              setEditing(
                tab === 'guides'
                  ? { kind: 'article', item: null }
                  : { kind: 'template', item: null },
              )
            }
          >
            {tab === 'guides' ? '+ New guide' : '+ New template'}
          </Button>
        </div>
      ) : null}
      <FormError message={remove.error} />
      {tab === 'guides' ? (
        articles.length === 0 ? (
          <EmptyState>No care guides yet.</EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <ul className="flex flex-col gap-1">
              {articles.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setReading(a)}
                    aria-current={reading?.id === a.id ? 'true' : undefined}
                    className={`w-full rounded-md px-3 py-2 text-left text-[13.5px] ${
                      reading?.id === a.id ? 'bg-primary-tint text-primary' : 'hover:bg-thead'
                    }`}
                  >
                    <span className="block font-medium">{a.title}</span>
                    <span className="text-xs text-muted">{KB_CATEGORY_LABEL[a.category]}</span>
                  </button>
                </li>
              ))}
            </ul>
            {reading ? (
              <article className="rounded-lg border border-line bg-white p-5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-[17px] font-semibold">{reading.title}</h2>
                  <Pill tone="blue">{KB_CATEGORY_LABEL[reading.category]}</Pill>
                </div>
                <div className="whitespace-pre-wrap text-[14px] leading-relaxed">
                  {reading.body}
                </div>
                <div className="mt-4 flex gap-3 text-xs">
                  {rights.edit ? (
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => setEditing({ kind: 'article', item: reading })}
                    >
                      Edit
                    </button>
                  ) : null}
                  {rights.full ? (
                    <button
                      type="button"
                      className="text-danger"
                      onClick={() => del('articles', reading.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </article>
            ) : null}
          </div>
        )
      ) : templates.length === 0 ? (
        <EmptyState>No reply templates yet.</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <article key={t.id} className="rounded-lg border border-line bg-white p-4 text-[13px]">
              <h3 className="mb-1 font-semibold">{t.title}</h3>
              <p className="whitespace-pre-wrap text-muted">{t.body}</p>
              <div className="mt-2 flex gap-3 text-xs">
                {rights.edit ? (
                  <button
                    type="button"
                    className="text-primary"
                    onClick={() => setEditing({ kind: 'template', item: t })}
                  >
                    Edit
                  </button>
                ) : null}
                {rights.full ? (
                  <button
                    type="button"
                    className="text-danger"
                    onClick={() => del('templates', t.id)}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      {editing ? <EditDrawer editing={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function EditDrawer({ editing, onClose }: { editing: NonNullable<Editing>; onClose: () => void }) {
  const router = useRouter();
  const article = editing.kind === 'article';
  const item = editing.item;
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [category, setCategory] = useState<KbCategory>(
    article && editing.item ? editing.item.category : 'care',
  );
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const base = `/api/v1/kb/${article ? 'articles' : 'templates'}`;
  const save = () =>
    run(
      () =>
        apiFetch(item ? `${base}/${item.id}` : base, {
          method: item ? 'PATCH' : 'POST',
          idempotencyKey,
          body: article ? { title, body, category } : { title, body },
        }),
      () => {
        onClose();
        router.refresh();
      },
    );
  return (
    <Drawer
      title={`${item ? 'Edit' : 'New'} ${article ? 'care guide' : 'reply template'}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={article ? 'Title' : 'Name'} htmlFor="kb-title">
          <Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {article ? (
          <Field label="Category" htmlFor="kb-cat">
            <select
              id="kb-cat"
              className={selectCls}
              value={category}
              onChange={(e) => setCategory(e.target.value as KbCategory)}
            >
              {(Object.keys(KB_CATEGORY_LABEL) as KbCategory[]).map((c) => (
                <option key={c} value={c}>
                  {KB_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field
          label={article ? 'Guide' : 'Message'}
          htmlFor="kb-body"
          hint={article ? undefined : 'Placeholders: {client} {ticket} {project} {engineer} {date}'}
        >
          <textarea
            id="kb-body"
            className={`${textareaCls} min-h-[200px]`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
