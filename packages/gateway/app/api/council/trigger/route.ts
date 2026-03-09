import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

/**
 * POST /api/council/trigger (legacy route, proxies to pando-infra team)
 * Proxies to POST /v1/teams/pando-infra/trigger on the Pando node.
 * Body: { agent?: string, message?: string }
 * Returns: { status, message }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchFromNode("/v1/teams/pando-infra/trigger", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: body?.message }),
      signal: AbortSignal.timeout(60000),
    }, "primary");
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
