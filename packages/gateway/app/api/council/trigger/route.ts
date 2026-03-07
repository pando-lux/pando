import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

/**
 * POST /api/council/trigger
 * Proxies to POST /v1/council/trigger/:agent on the Pando node.
 * Body: { agent: "observer" | "qa" | "council", message?: string }
 * Returns: { agent, toolCalls, response }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agent = body?.agent;
    if (!agent || !["observer", "qa", "council"].includes(agent)) {
      return NextResponse.json({ error: "Invalid agent. Must be: observer, qa, or council" }, { status: 400 });
    }
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/trigger/${encodeURIComponent(agent)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: body.message }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
