import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

function nodeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// GET /api/chat/threads/[id] — get thread metadata and messages
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const res = await fetchFromNode(`/chat/threads/${encodeURIComponent(id)}`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ id, messages: [] }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/chat/threads/[id] error:", err?.message);
    return NextResponse.json({ id: "unknown", messages: [] }, { status: 500 });
  }
}

// PATCH /api/chat/threads/[id] — update thread metadata
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const res = await fetchFromNode(`/chat/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: nodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to update thread' }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("PATCH /api/chat/threads/[id] error:", err?.message);
    return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
  }
}
