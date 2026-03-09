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

// POST /api/projects/[id]/api-key — Generate or regenerate a project API key
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Check if body requests regeneration
    let regenerate = false;
    try {
      const body = await request.json();
      regenerate = body.regenerate === true;
    } catch {
      // No body or invalid JSON — default to generate
    }

    const endpoint = regenerate
      ? `${getNodeUrl('primary')}/v1/projects/${encodeURIComponent(id)}/api-key/regenerate`
      : `${getNodeUrl('primary')}/v1/projects/${encodeURIComponent(id)}/api-key`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: nodeHeaders(request),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Node error" }));
      return NextResponse.json(error, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("POST /api/projects/[id]/api-key error:", err?.message);
    return NextResponse.json(
      { error: "Failed to generate API key", details: err?.message },
      { status: 500 },
    );
  }
}
