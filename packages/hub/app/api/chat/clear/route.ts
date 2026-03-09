import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

export async function POST() {
  try {
    const nodeUrl = getNodeUrl('primary');
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(`${nodeUrl}/v1/chat/clear`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ success: false }, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("POST /api/chat/clear error:", err?.message || err);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
