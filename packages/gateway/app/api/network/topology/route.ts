import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const topology = await node.getTopology();
    return NextResponse.json(topology);
  } catch {
    return NextResponse.json({ nodes: [], edges: [] });
  }
}
