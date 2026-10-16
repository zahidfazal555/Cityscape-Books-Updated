'use client';

import { useEffect, type ReactNode } from 'react';

/** Right-hand drawer for create/edit forms (README "Drawers"). */
export function Drawer({
  title,
  width = 520,
  onClose,
  footer,
  children,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal aria-label={title}>
      <div className="absolute inset-0 bg-[rgba(16,24,40,.45)]" onClick={onClose} aria-hidden />
      <div
        className="absolute right-0 top-0 flex h-full max-w-full flex-col bg-white shadow-[-12px_0_32px_rgba(16,24,40,.18)]"
        style={{ width }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 rounded-md text-xl text-muted hover:bg-thead"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Chip-style single choice (role, state, mode…). */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-[30px] rounded-[15px] border px-3 text-[13px] ${
            o.value === value
              ? 'border-primary bg-primary-tint font-medium text-primary'
              : 'border-input bg-white text-body hover:bg-thead'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented control for rights levels; options outside `allowed` are not offered. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-track p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-7 min-w-[52px] rounded-[5px] px-2 text-[12.5px] ${
            o.value === value
              ? 'bg-white font-medium text-primary shadow-sm'
              : 'text-muted hover:text-body'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'grey' | 'blue';
  children: ReactNode;
}) {
  const cls = {
    green: 'bg-success-bg text-success',
    amber: 'bg-[#FCF1DC] text-warn',
    red: 'bg-[#FDECEA] text-danger',
    grey: 'bg-track text-muted',
    blue: 'bg-primary-tint text-primary',
  }[tone];
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-[11px] px-2.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

/** Card + CSS-grid table (README "Tables"). */
export function Table({
  columns,
  children,
  minWidth = 760,
}: {
  columns: string;
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <div role="table" style={{ minWidth, ['--cols' as string]: columns }} className="text-[13px]">
        {children}
      </div>
    </div>
  );
}

export function Row({
  head,
  children,
  onClick,
}: {
  head?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      role="row"
      onClick={onClick}
      className={`grid items-center gap-3 border-b border-divider px-4 [grid-template-columns:var(--cols)] ${
        head
          ? 'h-9 bg-thead text-[11px] font-semibold uppercase tracking-[.05em] text-muted'
          : `min-h-[44px] py-2 ${onClick ? 'cursor-pointer hover:bg-thead' : ''}`
      }`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold">{title}</h1>
        {subtitle ? <p className="text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
