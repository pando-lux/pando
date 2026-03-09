import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const data = await node.getNetworkOverview();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({
      nodes: { self: "", peerCount: 0, peers: [] },
      agents: { local: null, knownAgents: [] },
      activeProposals: 0,
      recentActivity: [],
      luxMetrics: { totalSupply: 0, circulatingSupply: 0, totalBurned: 0, totalRelayFees: 0, totalAccounts: 0, totalTransactions: 0 },
      uptime: 0,
    });
  }
}
