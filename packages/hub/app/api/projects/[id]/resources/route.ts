import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

function nodeHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const userToken = request.headers.get("X-User-Token");
  if (userToken) headers["X-User-Token"] = userToken;
  return headers;
}

// GET /api/projects/[id]/resources — Get all resources assigned to a project
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const res = await fetch(`${getNodeUrl('primary')}/v1/projects/${encodeURIComponent(id)}/resources`, {
      method: "GET",
      headers: nodeHeaders(request),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Node error" }));
      return NextResponse.json(error, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("GET /api/projects/[id]/resources error:", err?.message);
    return NextResponse.json(
      { error: "Failed to fetch project resources", details: err?.message },
      { status: 500 },
    );
  }
}

// POST /api/projects/[id]/resources — Assign a resource to a project
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body.type || !body.resourceId) {
      return NextResponse.json(
        { error: "Missing required fields: type, resourceId" },
        { status: 400 },
      );
    }

    const res = await fetch(`${getNodeUrl('primary')}/v1/projects/${encodeURIComponent(id)}/resources/assign`, {
      method: "POST",
      headers: nodeHeaders(request),
      body: JSON.stringify({ type: body.type, resourceId: body.resourceId }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Node error" }));
      return NextResponse.json(error, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("POST /api/projects/[id]/resources error:", err?.message);
    return NextResponse.json(
      { error: "Failed to assign resource", details: err?.message },
      { status: 500 },
    );
  }
}
