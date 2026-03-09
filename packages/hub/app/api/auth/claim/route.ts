import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const authHeader = request.headers.get("Authorization") || "";

    const res = await fetchFromNode("/v1/auth/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to claim account", details: err?.message },
      { status: 500 },
    );
  }
}
