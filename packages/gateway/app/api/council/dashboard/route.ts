import { NextResponse } from 'next/server';
import { fetchFromNode, getApiToken } from '@/lib/node-connection';

/**
 * GET /api/council/dashboard
 * Proxies to GET /v1/teams/pando-infra/status on the Pando node.
 * Returns team health/status for the pando-infra team.
 */
export async function GET() {
  try {
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetchFromNode('/v1/teams/pando-infra/status', {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Node unreachable' }, { status: 502 });
  }
}
