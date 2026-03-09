import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

function authHeaders(request?: Request, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Forward user auth token so node can identify the requesting user
  if (request) {
    const userToken = request.headers.get("x-user-token");
    if (userToken) headers["X-User-Token"] = userToken;
    const cookie = request.headers.get("cookie");
    if (cookie) headers["Cookie"] = cookie;
  }

  return headers;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const res = await fetch(`${getNodeUrl('primary')}/v1/resources/${id}/owner`, {
      method: "PATCH",
      headers: authHeaders(request, { "Content-Type": "application/json" }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to link resource" }, { status: 500 });
  }
}
