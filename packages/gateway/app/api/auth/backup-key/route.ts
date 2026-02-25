import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

// POST /api/auth/backup-key -- Store encrypted private key backup (Phase 41.5)
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const authHeader = request.headers.get("Authorization") || "";

    const res = await fetchFromNode("/v1/auth/backup-key", {
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
      { error: "Failed to store key backup", details: err?.message },
      { status: 500 },
    );
  }
}

// GET /api/auth/backup-key -- Retrieve encrypted private key backup (Phase 41.5)
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("Authorization") || "";

    const res = await fetchFromNode("/v1/auth/backup-key", {
      method: "GET",
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to retrieve key backup", details: err?.message },
      { status: 500 },
    );
  }
}
