'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Rights, Role } from '@csd/core';
import { Button } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';
import { istDateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/labels';
import { PasswordDrawer } from './password-drawer';
import { UserDrawer, type EditableUser } from './user-drawer';

export interface UserView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  projectsAll: boolean;
  projectIds: string[];
  rights: Rights;
  rightsLabel: 'Full access' | 'Role default' | 'Custom rights';
  lastLoginAt: string | null;
  accessExpiresAt: string | null;
  invitePending: boolean;
}
export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

export function UsersAdmin({ users, projects }: { users: UserView[]; projects: ProjectOption[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<EditableUser | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<UserView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(path: string) {
    setError(null);
    try {
      await apiFetch(path, { method: 'POST' });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'That did not work. Try again.');
    }
  }

  return (
    <>
      <PageHeader
        title="Users & access"
        subtitle="Rights are set per person. A role only pre-fills them."
        action={<Button onClick={() => setEditing('new')}>+ Add user</Button>}
      />
      {notice ? (
        <p
          role="status"
          className="mb-3 rounded-md bg-success-bg px-3 py-2 text-[13px] text-success"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <Table columns="2.2fr 1.4fr 1.1fr 1fr 1.2fr 0.9fr 2.2fr" minWidth={1100}>
        <Row head>
          <span>User</span>
          <span>Role</span>
          <span>Rights</span>
          <span>Projects</span>
          <span>Last sign-in</span>
          <span>Status</span>
          <span />
        </Row>
        {users.map((u) => (
          <Row key={u.id}>
            <span className="min-w-0">
              <span className="block truncate font-medium">{u.name}</span>
              <span className="block truncate text-xs text-muted">{u.email}</span>
            </span>
            <span>{ROLE_LABEL[u.role]}</span>
            <span>
              <Pill
                tone={
                  u.rightsLabel === 'Custom rights'
                    ? 'amber'
                    : u.rightsLabel === 'Full access'
                      ? 'blue'
                      : 'grey'
                }
              >
                {u.rightsLabel}
              </Pill>
            </span>
            <span>
              {u.role === 'owner' || u.projectsAll ? 'All' : `${u.projectIds.length} selected`}
            </span>
            <span className="num text-muted">{istDateTime(u.lastLoginAt)}</span>
            <span>
              {!u.isActive ? (
                <Pill tone="red">Inactive</Pill>
              ) : u.invitePending ? (
                <Pill tone="amber">Invite pending</Pill>
              ) : (
                <Pill tone="green">Active</Pill>
              )}
            </span>
            <span className="flex justify-end gap-1.5">
              {u.role === 'owner' ? (
                // A company has one owner: the owner's row is the person signed in.
                <Link
                  href="/account/password"
                  className="flex h-[26px] items-center rounded-md border border-input bg-white px-2 text-xs font-medium text-primary hover:bg-thead"
                >
                  Change password
                </Link>
              ) : (
                <Button
                  variant="ghost"
                  className="h-[26px] px-2 text-xs"
                  onClick={() => {
                    setNotice(null);
                    setPasswordFor(u);
                  }}
                >
                  Set password
                </Button>
              )}
              {u.role === 'owner' ? (
                <span className="self-center text-xs text-muted">Always full access</span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    className="h-[26px] px-2 text-xs"
                    onClick={() => setEditing(u)}
                  >
                    Edit rights
                  </Button>
                  {u.isActive && u.invitePending ? (
                    <Button
                      variant="ghost"
                      className="h-[26px] px-2 text-xs"
                      onClick={() => act(`/api/v1/users/${u.id}/invite`)}
                    >
                      Resend invite
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    className="h-[26px] px-2 text-xs"
                    onClick={() =>
                      act(`/api/v1/users/${u.id}/${u.isActive ? 'deactivate' : 'activate'}`)
                    }
                  >
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </>
              )}
            </span>
          </Row>
        ))}
      </Table>
      {passwordFor ? (
        <PasswordDrawer
          user={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={() => {
            setNotice(
              `Password set for ${passwordFor.name}. They have been signed out everywhere.`,
            );
            setPasswordFor(null);
            router.refresh();
          }}
        />
      ) : null}
      {editing ? (
        <UserDrawer
          user={editing === 'new' ? null : editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
