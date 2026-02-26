import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { proposalId, reason } = body || {};
    if (!proposalId) {
      return NextResponse.json({ error: "proposalId is required" }, { status: 400 });
    }
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/veto/${encodeURIComponent(proposalId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
