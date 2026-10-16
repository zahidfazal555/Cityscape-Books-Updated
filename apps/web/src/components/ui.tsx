import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-body">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-9 rounded-md border border-input bg-white px-3 text-[13.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-tint"
    />
  );
}

export function Button({
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-primary text-white hover:bg-primary-hover',
    ghost: 'bg-white text-primary border border-input hover:bg-thead',
    danger: 'bg-danger text-white hover:opacity-90',
  }[variant];
  return (
    <button
      {...props}
      className={`h-9 rounded-md px-4 text-[13.5px] font-medium disabled:opacity-60 ${styles} ${props.className ?? ''}`}
    />
  );
}

/** Inline form error (README "Errors"). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger">
      {message}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-dashline bg-white px-6 py-10 text-center text-[13.5px] text-muted">
      {children}
    </div>
  );
}
