import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/directive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}

export async function GET() {
  try {
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/directives`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
