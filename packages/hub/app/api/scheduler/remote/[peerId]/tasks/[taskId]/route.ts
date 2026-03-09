import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl('primary');


export async function GET(
  request: Request,
  { params }: { params: Promise<{ peerId: string; taskId: string }> }
) {
  try {
    const { peerId, taskId } = await params;
    const res = await fetch(
      `${NODE_URL}/v1/scheduler/remote/${encodeURIComponent(peerId)}/tasks/${encodeURIComponent(taskId)}`,
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
