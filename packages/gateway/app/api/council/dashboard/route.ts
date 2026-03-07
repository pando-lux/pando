import { NextResponse } from 'next/server';
import { getNodeUrl } from '@/lib/node-connection';

/**
 * GET /api/council/dashboard
 * Proxies to GET /v1/council/status on the Pando node.
 * Returns: { active, engines: [{id, role, status}], schedules: [{name, interval}] }
 */
export async function GET() {
  try {
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/status`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Node unreachable' }, { status: 502 });
  }
}
