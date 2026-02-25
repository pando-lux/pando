import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

function authHeaders(request?: Request, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Forward user auth token so node can identify the resource owner
  if (request) {
    const userToken = request.headers.get("x-user-token");
    if (userToken) headers["X-User-Token"] = userToken;
    // Also check cookie-based auth
    const cookie = request.headers.get("cookie");
    if (cookie) headers["Cookie"] = cookie;
  }

  return headers;
}

export async function GET() {
  try {
    const res = await fetch(`${getNodeUrl()}/resources`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ resources: [] });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${getNodeUrl()}/resources/register`, {
      method: "POST",
      headers: authHeaders(request, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Registration failed" }, { status: 500 });
  }
}
