import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("Authorization") || "";
    // Forward user token as X-User-Token (node expects this header for user auth)
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    const res = await fetchFromNode("/auth/me", {
      headers: {
        ...(token ? { "X-User-Token": token } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to get user info", details: err?.message },
      { status: 500 },
    );
  }
}
