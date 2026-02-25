import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();


export async function GET() {
  try {
    const res = await fetch(`${NODE_URL}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("Node not responding");
    const data = await res.json();
    return NextResponse.json({
      status: "ok",
      node: "up",
      uptime: data.uptime ?? null,
      version: "0.1.0",
      peers: data.peers ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({
      status: "degraded",
      node: "unreachable",
      uptime: null,
      version: "0.1.0",
      peers: 0,
      timestamp: new Date().toISOString(),
    });
  }
}
