import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetchFromNode(`/v1/marketplace/${encodeURIComponent(id)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    }, 'primary');

    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/marketplace/[id] error:", err?.message);
    return NextResponse.json({ error: "Failed to fetch project" }, { status: 500 });
  }
}
