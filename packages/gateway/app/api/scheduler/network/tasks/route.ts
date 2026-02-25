import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();


export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit") || "50";
    const res = await fetch(`${NODE_URL}/v1/scheduler/network/tasks?limit=${limit}`, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ tasks: [], sources: {} });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ tasks: [], sources: {} });
  }
}
