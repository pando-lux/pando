import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(
      `${NODE_URL}/v1/scheduler/tasks/${encodeURIComponent(id)}/logs`,
      {
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "No logs available" }));
      return NextResponse.json(body, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch logs" },
      { status: 500 }
    );
  }
}
