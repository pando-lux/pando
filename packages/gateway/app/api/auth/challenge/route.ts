import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Phase 86: No primary pinning needed — challenge tokens are self-verifying (stateless).
    // Any node can issue a challenge, any node can verify it.
    const res = await fetchFromNode("/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to request challenge", details: err?.message },
      { status: 500 },
    );
  }
}
