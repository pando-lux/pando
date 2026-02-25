import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Phase 86: No primary pinning needed — challenge tokens are self-verifying (stateless).
    // Verify can hit ANY node, even a different one from the challenge issuer.
    const res = await fetchFromNode("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to verify signature", details: err?.message },
      { status: 500 },
    );
  }
}
