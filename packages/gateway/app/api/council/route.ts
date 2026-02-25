import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function GET() {
  try {
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/council`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
