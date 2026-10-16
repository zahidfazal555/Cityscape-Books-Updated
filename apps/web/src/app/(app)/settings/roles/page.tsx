import { MODULES, roleTemplate } from '@csd/core';
import { Row, Table } from '@/components/kit';
import { LEVEL_LABEL, MODULE_LABEL, ROLE_LABEL } from '@/lib/labels';

const ROLES = ['admin', 'manager', 'asstmgr', 'site', 'auditor'] as const;

/** Read-only matrix of the defaults a role pre-fills (Requirements §2.3, Figure 1). */
export default function RolesPage() {
  return (
    <>
      <p className="mb-3 text-[13px] text-muted">
        The owner always has full access. These are the starting rights for each role; you can
        change any module for any person.
      </p>
      <Table columns="2.2fr repeat(5, 1fr)" minWidth={900}>
        <Row head>
          <span>Module</span>
          {ROLES.map((r) => (
            <span key={r}>{ROLE_LABEL[r].split(' · ')[0]}</span>
          ))}
        </Row>
        {MODULES.map((m) => (
          <Row key={m}>
            <span>{MODULE_LABEL[m]}</span>
            {ROLES.map((r) => {
              const level = roleTemplate(r)[m];
              return (
                <span
                  key={r}
                  className={
                    level === 'none' ? 'text-subtle' : level === 'full' ? 'font-medium' : ''
                  }
                >
                  {level === 'none' ? '—' : LEVEL_LABEL[level]}
                </span>
              );
            })}
          </Row>
        ))}
      </Table>
    </>
  );
}
