import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function GET() {
  try {
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetchFromNode("/chat/sessions", {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ sessions: [] }, { status: 200 });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
