/**
 * Gateway health status endpoint.
 * Phase 43: Returns multi-node pool status — healthy count, node details, latencies.
 */

import { getNodePool } from "@/lib/node-pool";

export async function GET() {
  const pool = getNodePool();
  const status = pool.getStatus();

  return Response.json({
    nodes: status.nodes.map(n => ({
      url: n.url,
      peerId: n.peerId,
      healthy: n.healthy,
      latencyMs: n.latencyMs,
      lastCheck: n.lastCheck,
      consecutiveFailures: n.consecutiveFailures,
      capabilities: n.capabilities,
      circuitOpen: n.circuitOpen,
    })),
    primaryUrl: status.primaryUrl,
    healthyCount: status.healthyCount,
    totalCount: status.totalCount,
  });
}

export const dynamic = "force-dynamic";
