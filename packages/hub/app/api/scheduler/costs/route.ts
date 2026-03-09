import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl('primary');


export async function GET() {
  try {
    const res = await fetch(`${NODE_URL}/v1/scheduler/costs`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ totalCostUsd: 0, taskCount: 0, byTier: {} });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ totalCostUsd: 0, taskCount: 0, byTier: {} });
  }
}
