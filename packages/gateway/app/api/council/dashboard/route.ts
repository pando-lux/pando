import { NextResponse } from 'next/server';
import { fetchFromNode, getApiToken } from '@/lib/node-connection';

/**
 * GET /api/council/dashboard (legacy route, proxies to pando-infra team)
 * Aggregates data from:
 *   - GET /v1/teams/pando-infra/status  (team health, agents)
 *   - GET /v1/teams/pando-infra/board   (board tasks)
 *   - GET /v1/teams/pando-infra/cost    (token/cost summary)
 * Returns a combined response consumed by both council/page.tsx and dashboard/page.tsx.
 */
export async function GET() {
  try {
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { headers, signal: AbortSignal.timeout(8000) };

    const [statusRes, boardRes, costRes] = await Promise.allSettled([
      fetchFromNode('/v1/teams/pando-infra/status', opts),
      fetchFromNode('/v1/teams/pando-infra/board', opts),
      fetchFromNode('/v1/teams/pando-infra/cost', opts),
    ]);

    // Parse status (required)
    if (statusRes.status === 'rejected') {
      return NextResponse.json({ error: 'Upstream error (status)' }, { status: 502 });
    }
    if (!statusRes.value.ok) {
      return NextResponse.json({ error: 'Upstream error' }, { status: statusRes.value.status });
    }
    const status = await statusRes.value.json();

    // Parse board (optional — graceful degradation)
    let board: { tasks?: any[] } = { tasks: [] };
    if (boardRes.status === 'fulfilled' && boardRes.value.ok) {
      board = await boardRes.value.json();
    }

    // Parse cost (optional — graceful degradation)
    let cost: Record<string, any> = {};
    if (costRes.status === 'fulfilled' && costRes.value.ok) {
      cost = await costRes.value.json();
    }

    // Map agents to the engines shape expected by the council page
    const engines = (status.agents || []).map((a: any) => ({
      id: a.id,
      role: a.role || a.id,
      status: a.status || 'unknown',
    }));

    return NextResponse.json({
      // Fields used by council/page.tsx (InfraStatus)
      active: status.active ?? false,
      engines,
      schedules: [],

      // Fields used by dashboard/page.tsx (DashboardData)
      council: {
        orchestratorId: status.managingNode || 'unknown',
        status: status.active ? 'active' : 'inactive',
        role: 'infrastructure-lead',
        lastTickAt: '',
        sessionId: null,
        createdAt: '',
        budgetSpent: cost.totalCostLux ?? 0,
      },
      workers: (status.agents || []).map((a: any) => ({
        id: a.id,
        role: a.role || a.id,
        status: a.status || 'unknown',
        spawnedAt: '',
        lastReportAt: null,
        lastReport: null,
      })),
      observer: engines.find((e: any) => e.id === 'observer') ?? null,
      recentCommits: [],

      // Additional data
      board: board.tasks || [],
      cost,
    });
  } catch {
    return NextResponse.json({ error: 'Node unreachable' }, { status: 502 });
  }
}
