import pg from 'pg';
import {
  anonymiseCallers,
  bootstrapCompany,
  slaSweep,
  verifyBooks,
  type JobPools,
} from './jobs.js';

/**
 * `pnpm jobs <sla-sweep|retention|verify-books|bootstrap>`; schedule from cron (docs/GO-LIVE.md).
 * Needs DATABASE_URL (app role) and DATABASE_ADMIN_URL (sees every company). Exit code 1 on failure.
 */
const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

const JOBS: Record<string, (p: JobPools, args: string[]) => Promise<number>> = {
  'sla-sweep': async (p) => (print(await slaSweep(p)), 0),
  retention: async (p) => (print(await anonymiseCallers(p)), 0),
  'verify-books': async (p) => {
    const result = await verifyBooks(p.admin);
    print(result);
    return result.every((r) => r.ok) ? 0 : 1;
  },
  bootstrap: async (p, [company, ownerName, ownerEmail]) => {
    if (!company || !ownerName || !ownerEmail)
      throw new Error('Usage: jobs bootstrap "<company>" "<owner name>" <owner email>');
    print(await bootstrapCompany(p.admin, { company, ownerName, ownerEmail }));
    return 0;
  },
};

async function main(job: string | undefined, args: string[]): Promise<number> {
  const run = job ? JOBS[job] : undefined;
  if (!run) throw new Error(`Usage: jobs <${Object.keys(JOBS).join('|')}>`);
  const appUrl = process.env['DATABASE_URL'];
  const adminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL and DATABASE_ADMIN_URL are required.');
  const app = new pg.Pool({ connectionString: appUrl, max: 2 });
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  try {
    return await run({ app, admin }, args);
  } finally {
    await Promise.all([app.end(), admin.end()]);
  }
}

main(process.argv[2], process.argv.slice(3)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
