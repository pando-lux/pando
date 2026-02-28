import { NextRequest, NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function GET(request: NextRequest) {
  try {
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    // Forward user token so the node can scope history to the authenticated user
    const userToken = request.headers.get("X-User-Token");
    if (userToken) {
      headers["X-User-Token"] = userToken;
    }

    // Forward projectId query param if present
    const projectId = request.nextUrl.searchParams.get("projectId");
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const res = await fetchFromNode(`/v1/chat/history${qs}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ messages: [] }, { status: 200 });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ messages: [] });
  }
}
