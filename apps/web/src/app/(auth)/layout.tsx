import Image from 'next/image';
import type { ReactNode } from 'react';

/** Split sign-in layout (README §1). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-wrap bg-white">
      <section className="flex flex-[1_1_420px] flex-col justify-between gap-10 bg-[#EEF4FA] px-8 py-12 sm:px-14">
        <Image
          src="/brand/cityscape-logo.png"
          alt="Cityscape Decors"
          width={160}
          height={40}
          priority
          className="h-10 w-auto"
        />
        <div className="max-w-md">
          <h1 className="text-[38px] font-semibold leading-tight text-heading">
            Every site, every rupee, in one set of books.
          </h1>
          <p className="mt-4 text-base text-muted">
            Quotations, invoices, site expenses, GST and payroll for Cityscape Decors, tagged to
            every project.
          </p>
        </div>
        <p className="text-xs text-subtle">
          Cityscape Decors · Interiors &amp; Construction · Chennai
        </p>
      </section>
      <section className="flex flex-[1_1_420px] items-center justify-center px-6 py-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </section>
    </main>
  );
}
