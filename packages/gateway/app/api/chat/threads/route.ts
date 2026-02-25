import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

function nodeHeaders(request?: Request): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Forward user session token so the node can filter by user
  if (request) {
    const userToken = request.headers.get("X-User-Token");
    if (userToken) headers["X-User-Token"] = userToken;
  }
  return headers;
}

// GET /api/chat/threads — list threads for the authenticated user
export async function GET(request: Request) {
  try {
    const res = await fetchFromNode("/v1/chat/threads", {
      headers: nodeHeaders(request),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ threads: [] }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/chat/threads error:", err?.message);
    return NextResponse.json({ threads: [] }, { status: 500 });
  }
}

// POST /api/chat/threads — create a new thread
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetchFromNode("/v1/chat/threads", {
      method: "POST",
      headers: nodeHeaders(request),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    console.error("POST /api/chat/threads error:", err?.message);
    return NextResponse.json({ error: "Failed to create thread" }, { status: 500 });
  }
}
