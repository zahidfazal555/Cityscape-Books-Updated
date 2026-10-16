import { NextResponse } from 'next/server';
import { services } from '@/lib/server';

/** Liveness + database check for the uptime probe (ENGINEERING-STANDARDS §7). No data returned. */
export async function GET(): Promise<Response> {
  try {
    await services().pool.query('SELECT 1');
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
