import Image from 'next/image';
import type { ReactNode } from 'react';
import { financialYear, todayIn } from '@csd/core';
import { ROLE_LABEL } from '@/lib/labels';
import { getSession } from '@/lib/session';
import { SideNav } from './side-nav';
import { SignOutButton } from './sign-out';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { actor, name, company } = await getSession();
  const fy = financialYear(todayIn(), company.fyStartMonth);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-line bg-white px-5">
        <Image
          src="/brand/cityscape-logo.png"
          alt="Cityscape Decors"
          width={96}
          height={24}
          className="h-6 w-auto"
        />
        <span className="h-[22px] w-px bg-line" aria-hidden />
        <span className="text-[13px] text-muted">Books · FY 20{fy}</span>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right leading-tight">
            <div className="text-[13px] font-medium">{name}</div>
            <div className="text-xs text-muted">{ROLE_LABEL[actor.role]}</div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <div className="flex">
        <SideNav actor={actor} lockDate={company.lockDate} />
        <main className="min-w-0 flex-1 px-7 pb-14 pt-6">
          <div className="mx-auto max-w-[1320px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
