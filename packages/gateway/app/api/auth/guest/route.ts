import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    // Phase 41: Forward browser-generated public key to node
    let body: string | undefined;
    try {
      const json = await request.json();
      if (json && Object.keys(json).length > 0) {
        body = JSON.stringify(json);
      }
    } catch {
      // No body or invalid JSON — fine, node handles empty body
    }
    const res = await fetchFromNode("/v1/auth/guest", {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to create guest session", details: err?.message },
      { status: 500 },
    );
  }
}
