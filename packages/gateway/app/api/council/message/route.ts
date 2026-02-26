import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // AI calls can take a while
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
