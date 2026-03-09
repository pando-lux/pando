import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams.toString();
    const res = await fetch(`${NODE_URL}/v1/content${params ? `?${params}` : ""}`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ content: [] });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ content: [] });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = getApiToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${NODE_URL}/v1/content`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to create content" }, { status: 500 });
  }
}
