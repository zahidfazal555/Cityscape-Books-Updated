import pg from 'pg';
import {
  anonymiseCallers,
  bootstrapCompany,
  slaSweep,
  verifyBooks,
  type JobFailure,
} from './jobs.js';

/**
 * `pnpm jobs <sla-sweep|retention|verify-books|bootstrap>`; schedule from cron (docs/GO-LIVE.md).
 * The scheduled jobs need only DATABASE_URL (the app role); `bootstrap` also needs
 * DATABASE_ADMIN_URL. Exit code 1 on any failure or problem, so cron alerts.
 */
const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
const code = (failures: JobFailure[]) => (failures.length === 0 ? 0 : 1);

const JOBS: Record<string, (app: pg.Pool, args: string[]) => Promise<number>> = {
  'sla-sweep': async (app) => {
    const r = await slaSweep(app);
    print(r);
    return code(r.failures);
  },
  retention: async (app) => {
    const r = await anonymiseCallers(app);
    print(r);
    return code(r.failures);
  },
  'verify-books': async (app) => {
    const r = await verifyBooks(app);
    print(r);
    return r.failures.length === 0 && r.checks.every((x) => x.ok) ? 0 : 1;
  },
  bootstrap: async (_app, args) => {
    const another = args.includes('--another');
    const [company, ownerName, ownerEmail] = args.filter((a) => a !== '--another');
    if (!company || !ownerName || !ownerEmail)
      throw new Error('Usage: jobs bootstrap "<company>" "<owner name>" <owner email> [--another]');
    const adminUrl = process.env['DATABASE_ADMIN_URL'];
    if (!adminUrl) throw new Error('bootstrap needs DATABASE_ADMIN_URL.');
    const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    try {
      print(await bootstrapCompany(admin, { company, ownerName, ownerEmail, another }));
    } finally {
      await admin.end();
    }
    return 0;
  },
};

async function main(job: string | undefined, args: string[]): Promise<number> {
  const run = job ? JOBS[job] : undefined;
  if (!run) throw new Error(`Usage: jobs <${Object.keys(JOBS).join('|')}>`);
  const appUrl = process.env['DATABASE_URL'];
  if (!appUrl) throw new Error('DATABASE_URL is required.');
  const app = new pg.Pool({ connectionString: appUrl, max: 2 });
  try {
    return await run(app, args);
  } finally {
    await app.end();
  }
}

main(process.argv[2], process.argv.slice(3)).then(
  (exit) => process.exit(exit),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
