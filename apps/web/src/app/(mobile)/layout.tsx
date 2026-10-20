import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '../(app)/sign-out';

export const dynamic = 'force-dynamic';

/** README §17: phone layout, max 430px, touch targets ≥ 44px; no side navigation. */
export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-white px-4">
        <Image
          src="/brand/cityscape-logo.png"
          alt="Cityscape Decors"
          width={113}
          height={24}
          className="h-6 w-auto"
        />
        <div className="flex items-center gap-2">
          <Link
            href="/account/password"
            className="flex h-11 items-center rounded-md border border-input px-3 text-[13px] text-body hover:bg-thead"
          >
            Password
          </Link>
          <SignOutButton large />
        </div>
      </header>
      <main className="mx-auto max-w-[430px] px-4 pb-24 pt-4">{children}</main>
    </div>
  );
}
