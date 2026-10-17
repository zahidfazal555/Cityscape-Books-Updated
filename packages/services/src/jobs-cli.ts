import pg from 'pg';
import { anonymiseCallers, slaSweep, verifyBooks } from './jobs.js';

const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

/**
 * `pnpm jobs <sla-sweep|retention|verify-books>`; schedule from cron (see docs/GO-LIVE.md).
 * Needs DATABASE_URL (app role) and DATABASE_ADMIN_URL (sees every company). Exit code 1 on failure.
 */
async function main(job: string | undefined): Promise<number> {
  const appUrl = process.env['DATABASE_URL'];
  const adminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL and DATABASE_ADMIN_URL are required.');
  const app = new pg.Pool({ connectionString: appUrl, max: 2 });
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  try {
    if (job === 'sla-sweep') print(await slaSweep({ app, admin }));
    else if (job === 'retention') print(await anonymiseCallers({ app, admin }));
    else if (job === 'verify-books') {
      const result = await verifyBooks(admin);
      print(result);
      return result.every((r) => r.ok) ? 0 : 1;
    } else throw new Error('Usage: jobs <sla-sweep|retention|verify-books>');
    return 0;
  } finally {
    await Promise.all([app.end(), admin.end()]);
  }
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
