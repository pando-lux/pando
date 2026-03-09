import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

export async function GET() {
  try {
    const nodeUrl = getNodeUrl('primary');
    const res = await fetch(`${nodeUrl}/v1/capacity`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node unreachable" }, { status: 502 });
  }
}
