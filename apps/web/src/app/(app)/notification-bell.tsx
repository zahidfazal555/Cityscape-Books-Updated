'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { AppNotification } from '@csd/services';
import { apiFetch } from '@/lib/client';
import { istDateTime } from '@/lib/format';

type Data = { unread: number; items: AppNotification[] };

/**
 * The poll is a background request (BUG-163): it never counts as activity, never refreshes the
 * session and never redirects. Once the session ends it stops quietly.
 */
async function poll(): Promise<Data | 'signed-out' | null> {
  try {
    const r = await fetch('/api/v1/notifications', {
      credentials: 'same-origin',
      headers: { 'x-csd-background': '1' },
    });
    if (r.status === 401) return 'signed-out';
    return r.ok ? ((await r.json()) as Data) : null;
  } catch {
    return null;
  }
}

/** Header bell: SLA alerts and security notices for the signed-in user. */
export function NotificationBell() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const r = await poll();
      if (r === 'signed-out') stopped = true;
      else if (r) setData(r);
    };
    void load();
    const t = window.setInterval(() => void load(), 5 * 60_000);
    const onVisible = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);
  const markRead = async (ids?: string[]) => {
    await apiFetch('/api/v1/notifications/read', {
      method: 'POST',
      body: ids ? { ids } : {},
    }).catch(() => undefined);
    const r = await poll();
    if (r && r !== 'signed-out') setData(r);
  };
  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-thead"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[11px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id="notification-panel"
          className="absolute right-0 top-11 z-30 w-[340px] rounded-lg border border-line bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px]">
            <span className="font-semibold">Notifications</span>
            {unread > 0 ? (
              <button
                type="button"
                className="text-xs text-primary"
                onClick={() => void markRead()}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-[360px] overflow-y-auto">
            {items.length === 0 ? (
              <li className="px-3 py-4 text-[13px] text-muted">Nothing yet.</li>
            ) : null}
            {items.map((n) => (
              <li
                key={n.id}
                className={`border-b border-divider px-3 py-2 text-[13px] ${n.read ? '' : 'bg-primary-tint/40'}`}
              >
                {n.link ? (
                  <Link
                    href={n.link}
                    onClick={() => {
                      setOpen(false);
                      if (!n.read) void markRead([n.id]);
                    }}
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
