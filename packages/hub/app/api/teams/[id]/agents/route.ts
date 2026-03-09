import { NextResponse, NextRequest } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = getNodeConnection();
    const agents = await node.getTeamAgents(id);
    return NextResponse.json({ agents });
  } catch {
    return NextResponse.json({ agents: [] });
  }
}
