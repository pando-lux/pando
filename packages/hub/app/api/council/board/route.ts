import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function GET() {
  try {
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchFromNode("/v1/teams/pando-infra/board", {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
