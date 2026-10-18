'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Project } from '@csd/services';
import { Button, EmptyState } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { STATUS_LABEL, STATUS_TONE, rupees } from '@/lib/format';
import { ProjectDrawer, type ClientOption, type TeamOption } from './project-drawer';

const FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['on_hold', 'On hold'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
] as const;

export function ProjectsList({
  projects,
  filter,
  canEdit,
  clients,
  team,
}: {
  projects: Project[];
  filter: string;
  canEdit: boolean;
  clients: ClientOption[];
  team: TeamOption[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Every rupee is tagged to a project."
        action={canEdit ? <Button onClick={() => setAdding(true)}>+ New project</Button> : null}
      />
      <div className="mb-3 flex gap-1.5" role="group" aria-label="Filter by status">
        {FILTERS.map(([value, label]) => (
          <Link
            key={value}
            href={value === 'all' ? '/projects' : `/projects?status=${value}`}
            aria-current={filter === value ? 'true' : undefined}
            className={`h-[30px] rounded-[15px] border px-3 text-[13px] leading-[28px] ${
              filter === value
                ? 'border-primary bg-primary-tint font-medium text-primary'
                : 'border-input bg-white text-body'
            }`}
          >
            {label}
          </Link>
        ))}
      </div>
      {projects.length === 0 ? (
        <EmptyState>No projects here yet.</EmptyState>
      ) : (
        <Table columns="1fr 2.4fr 1.6fr 0.9fr 1fr 1fr" minWidth={900}>
          <Row head>
            <span>ID</span>
            <span>Project · client</span>
            <span>Site</span>
            <span>Status</span>
            <span className="text-right">Contract</span>
            <span className="text-right">Cost budget</span>
          </Row>
          {projects.map((p) => (
            <Row key={p.id}>
              <span className="font-mono text-[11.5px] text-muted">{p.code}</span>
              <span className="min-w-0">
                <Link
                  href={`/projects/${p.id}`}
                  className="block truncate font-medium hover:text-primary"
                >
                  {p.name}
                </Link>
                <span className="block truncate text-xs text-muted">{p.clientName}</span>
              </span>
              <span className="truncate text-muted">{p.siteAddress ?? '—'}</span>
              <span>
                <Pill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Pill>
              </span>
              <span className="num text-right">{rupees(p.contractValue)}</span>
              <span className="num text-right">{rupees(p.costBudget)}</span>
            </Row>
          ))}
        </Table>
      )}
      <p className="mt-2 text-xs text-subtle">
        Received and budget-used columns arrive with receipts and expenses.
      </p>
      {adding ? (
        <ProjectDrawer
          project={null}
          clients={clients}
          team={team}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            router.push(`/projects/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
