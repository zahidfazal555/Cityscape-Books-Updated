'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Project, ProjectStatus } from '@csd/services';
import { Button } from '@/components/ui';
import { ApiFailure, apiFetch } from '@/lib/client';
import { ProjectDrawer, type ClientOption, type TeamOption } from '../project-drawer';

const NEXT: Record<ProjectStatus, { to: ProjectStatus; label: string }[]> = {
  active: [
    { to: 'on_hold', label: 'Put on hold' },
    { to: 'completed', label: 'Mark completed' },
  ],
  on_hold: [
    { to: 'active', label: 'Resume' },
    { to: 'completed', label: 'Mark completed' },
  ],
  completed: [{ to: 'active', label: 'Reopen' }],
  cancelled: [{ to: 'active', label: 'Reopen' }],
};

export function ProjectActions({
  project,
  canReopen,
  clients,
  team,
}: {
  project: Project;
  canReopen: boolean;
  clients: ClientOption[];
  team: TeamOption[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moves = NEXT[project.status].filter((m) => m.label !== 'Reopen' || canReopen);

  async function move(to: ProjectStatus) {
    setError(null);
    try {
      await apiFetch(`/api/v1/projects/${project.id}`, { method: 'PATCH', body: { status: to } });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not change the status.');
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {moves.map((m) => (
          <Button key={m.to} variant="ghost" onClick={() => move(m.to)}>
            {m.label}
          </Button>
        ))}
        <Button onClick={() => setEditing(true)}>Edit project</Button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {editing ? (
        <ProjectDrawer
          project={project}
          clients={clients}
          team={team}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
