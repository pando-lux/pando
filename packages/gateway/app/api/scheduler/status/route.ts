import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();


export async function GET() {
  try {
    const res = await fetch(`${NODE_URL}/scheduler/status`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ running: false, activeTasks: 0, totalProcessed: 0, totalSucceeded: 0, totalFailed: 0 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ running: false, activeTasks: 0, totalProcessed: 0, totalSucceeded: 0, totalFailed: 0 });
  }
}
