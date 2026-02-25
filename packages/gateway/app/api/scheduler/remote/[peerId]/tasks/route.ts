import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();


export async function GET(
  request: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    const { peerId } = await params;
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit") || "50";
    const res = await fetch(
      `${NODE_URL}/scheduler/remote/${encodeURIComponent(peerId)}/tasks?limit=${limit}`,
      { signal: AbortSignal.timeout(12000), cache: "no-store" }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Remote query failed" }));
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Remote query timed out" }, { status: 504 });
  }
}
