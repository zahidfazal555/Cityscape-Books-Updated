/**
 * Runs once when the server starts. Validates configuration so a misconfigured deploy exits
 * immediately instead of serving pages that fail on first use (ENGINEERING-STANDARDS §1).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { env } = await import('./lib/env');
  try {
    env();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: (error as Error).message })}\n`);
    process.exit(1);
  }
}
