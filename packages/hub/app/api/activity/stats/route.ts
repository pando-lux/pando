import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl('primary');


export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const window = searchParams.get("window") || "24h";
  try {
    const res = await fetch(`${NODE_URL}/v1/activity/stats?window=${encodeURIComponent(window)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ total: 0, byAction: {}, byAgent: {} });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ total: 0, byAction: {}, byAgent: {} });
  }
}
