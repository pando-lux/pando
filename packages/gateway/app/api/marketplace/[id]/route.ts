import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

function nodeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const url = `${getNodeUrl()}/v1/marketplace/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/marketplace/[id] error:", err?.message);
    return NextResponse.json({ error: "Failed to fetch project" }, { status: 500 });
  }
}
