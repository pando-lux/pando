import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
