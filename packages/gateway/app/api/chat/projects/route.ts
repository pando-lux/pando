import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

export async function GET() {
  try {
    const nodeUrl = getNodeUrl();
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(`${nodeUrl}/chat/projects`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ projects: [], projectChats: [] }, { status: 200 });
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ projects: [], projectChats: [] });
  }
}
