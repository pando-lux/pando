import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetchFromNode(`/v1/marketplace${qs ? `?${qs}` : ''}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    }, 'primary');

    if (!res.ok) {
      return NextResponse.json({ projects: [], total: 0 }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/marketplace error:", err?.message);
    return NextResponse.json({ projects: [], total: 0 }, { status: 500 });
  }
}
