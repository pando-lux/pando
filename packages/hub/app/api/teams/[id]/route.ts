import { NextResponse, NextRequest } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = getNodeConnection();
    const team = await node.getTeam(id);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    return NextResponse.json(team);
  } catch {
    return NextResponse.json({ error: "Failed to fetch team" }, { status: 500 });
  }
}
