'use client';

import { useRouter } from 'next/navigation';
import { ExpenseForm } from '@/components/purchases/expense-form';
import type { ProjectOption } from '@/components/sales/use-action';

export function NewSiteExpense({ sites, isOwner }: { sites: ProjectOption[]; isOwner: boolean }) {
  const router = useRouter();
  return (
    <ExpenseForm
      projects={sites}
      isOwner={isOwner}
      defaultPaidBy="Site Engineer"
      mobile
      onDone={() => {
        router.push('/site');
        router.refresh();
      }}
    />
  );
}
