import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateNumber, withTenant } from '../src/index.js';
import { appPool, closePools, makeCompany, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await makeCompany();
});
afterAll(closePools);

describe('gapless numbering (SPEC-FIXES A8, guard-rail 5)', () => {
  it('50 concurrent inserts with rollbacks leave no gaps and no duplicates', async () => {
    const ctx = { companyId: f.companyId, userId: f.ownerId };
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        withTenant(appPool, ctx, async (c) => {
          const number = await allocateNumber(c, 'invoice', '2026-10-14');
          if (i % 5 === 0) throw new Error('simulated failure after allocation');
          return number;
        }),
      ),
    );
    const committed = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value)
      .sort();
    expect(committed).toHaveLength(40);
    expect(committed).toEqual(
      Array.from({ length: 40 }, (_, i) => `CSD/26-27/${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('restarts every financial year and keeps series apart', async () => {
    const ctx = { companyId: f.companyId, userId: f.ownerId };
    const got = await withTenant(appPool, ctx, async (c) => [
      await allocateNumber(c, 'invoice', '2027-04-01'),
      await allocateNumber(c, 'creditNote', '2026-10-14'),
      await allocateNumber(c, 'project', '2026-10-14'),
      await allocateNumber(c, 'project', '2027-10-14'),
    ]);
    expect(got).toEqual(['CSD/27-28/0001', 'CN/26-27/0001', 'CSD-PRJ-0001', 'CSD-PRJ-0002']);
  });

  it('companies have independent series', async () => {
    const other = await makeCompany('Other');
    const n = await withTenant(
      appPool,
      { companyId: other.companyId, userId: other.ownerId },
      (c) => allocateNumber(c, 'invoice', '2026-10-14'),
    );
    expect(n).toBe('CSD/26-27/0001');
  });
});
