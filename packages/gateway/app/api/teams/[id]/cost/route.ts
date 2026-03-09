import { NextResponse, NextRequest } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = getNodeConnection();
    const cost = await node.getTeamCost(id);
    if (!cost) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    return NextResponse.json(cost);
  } catch {
    return NextResponse.json({ error: "Failed to fetch team cost" }, { status: 500 });
  }
}
