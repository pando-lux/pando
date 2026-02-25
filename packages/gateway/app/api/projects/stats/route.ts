import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const stats = await node.getProjectStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ totalProjects: 0, activeProjects: 0, publicProjects: 0, totalCollaborators: 0 });
  }
}
