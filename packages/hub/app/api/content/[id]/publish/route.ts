import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const token = getApiToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${NODE_URL}/v1/content/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to publish content" }, { status: 500 });
  }
}
