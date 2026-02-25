import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("Authorization") || "";

    const res = await fetchFromNode("/auth/logout", {
      method: "POST",
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to logout", details: err?.message },
      { status: 500 },
    );
  }
}
