import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl('primary');

export async function GET() {
  try {
    const res = await fetch(`${NODE_URL}/v1/content/stats`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ totalContent: 0, byType: {}, byStatus: {}, totalLuxEarned: 0 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ totalContent: 0, byType: {}, byStatus: {}, totalLuxEarned: 0 });
  }
}
