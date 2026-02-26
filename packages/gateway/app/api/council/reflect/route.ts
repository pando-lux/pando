import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function POST() {
  try {
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/council/reflect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(120000), // reflections can take time
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
