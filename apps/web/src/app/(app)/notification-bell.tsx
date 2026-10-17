'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AppNotification } from '@csd/services';
import { apiFetch } from '@/lib/client';
import { istDateTime } from '@/lib/format';

/** Header bell: SLA alerts and security notices for the signed-in user. */
export function NotificationBell() {
  const [data, setData] = useState<{ unread: number; items: AppNotification[] } | null>(null);
  const [open, setOpen] = useState(false);
  const load = () =>
    apiFetch<{ unread: number; items: AppNotification[] }>('/api/v1/notifications')
      .then(setData)
      .catch(() => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  const markAll = async () => {
    await apiFetch('/api/v1/notifications/read', { method: 'POST', body: {} }).catch(
      () => undefined,
    );
    await load();
  };
  const unread = data?.unread ?? 0;
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-[18px] text-muted hover:bg-thead"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[11px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-30 w-[340px] rounded-lg border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px]">
            <span className="font-semibold">Notifications</span>
            {unread > 0 ? (
              <button type="button" className="text-xs text-primary" onClick={() => void markAll()}>
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-[360px] overflow-y-auto">
            {(data?.items ?? []).length === 0 ? (
              <li className="px-3 py-4 text-[13px] text-muted">Nothing yet.</li>
            ) : null}
            {(data?.items ?? []).map((n) => (
              <li
                key={n.id}
                className={`border-b border-divider px-3 py-2 text-[13px] ${n.read ? '' : 'bg-primary-tint/40'}`}
              >
                {n.link ? (
                  <Link
                    href={n.link}
                    onClick={() => setOpen(false)}
                    className="font-medium text-primary"
                  >
                    {n.title}
                  </Link>
                ) : (
                  <span className="font-medium">{n.title}</span>
                )}
                {n.body ? <div className="text-muted">{n.body}</div> : null}
                <div className="text-xs text-subtle">{istDateTime(n.createdAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
