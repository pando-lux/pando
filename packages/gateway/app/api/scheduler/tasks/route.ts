import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();


export async function GET() {
  try {
    const res = await fetch(`${NODE_URL}/v1/scheduler/tasks`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ tasks: [] });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ tasks: [] });
  }
}
