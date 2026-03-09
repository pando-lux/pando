import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchFromNode("/v1/teams/pando-infra/request", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }, "primary");
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
