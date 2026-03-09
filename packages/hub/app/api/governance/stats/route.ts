import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const stats = await node.getGovernanceStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ totalProposals: 0, reviewedCount: 0, avgRiskScore: 0, stakePool: 0, humanOnlyCount: 0, governanceChangeCount: 0, statusCounts: {} });
  }
}
