import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService, ContactsService } from '../src/index.js';
import { actorFor, appPool, closePools, makeCompany, makeUser, type Fixture } from './helpers.js';

const audit = new AuditService(appPool);
let f: Fixture;

beforeAll(async () => {
  f = await makeCompany('Audit Co');
  const owner = actorFor(f, f.ownerId, 'owner');
  const contacts = new ContactsService(appPool);
  for (let i = 0; i < 3; i++)
    await contacts.create(owner, { type: 'vendor', name: `V${i}`, stateCode: '33' });
});
afterAll(closePools);

describe('audit trail viewer', () => {
  it('owner and auditor read newest first with keyset paging; others are refused', async () => {
    const owner = actorFor(f, f.ownerId, 'owner');
    const page1 = await audit.list(owner, { limit: 2, entity: 'contact' });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.id).toBeGreaterThan(page1[1]!.id);
    expect(page1[0]!.userName).toBe('Owner');
    const page2 = await audit.list(owner, { limit: 2, entity: 'contact', beforeId: page1[1]!.id });
    expect(page2).toHaveLength(1);
    const auditor = actorFor(f, await makeUser(f.companyId, 'auditor'), 'auditor');
    await expect(audit.list(auditor)).resolves.toBeDefined();
    const admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
    await expect(audit.list(admin)).rejects.toMatchObject({ status: 403 });
  });
});
