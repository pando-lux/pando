import { NextResponse } from "next/server";

const TEAMS_URL = process.env.PANDO_TEAMS_URL || "http://127.0.0.1:4873";

export async function GET() {
  try {
    const res = await fetch(`${TEAMS_URL}/v1/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({ sessions: [] }, { status: res.status });
    }
    const sessions = await res.json();
    return NextResponse.json({ sessions });
  } catch (err: any) {
    console.warn(`[teams/sessions] Failed to fetch from ${TEAMS_URL}: ${err?.message || err}`);
    return NextResponse.json({ sessions: [] });
  }
}
