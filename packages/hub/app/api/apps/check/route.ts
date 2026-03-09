import { NextResponse } from "next/server";

/**
 * Server-side live check for deployed apps.
 * Accepts POST { url: string }, does a HEAD request (no CORS issues server-side),
 * returns { status: 'ok' | 'error', code?: number }.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const url: string = body?.url;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ status: "error" }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (res.ok) {
        return NextResponse.json({ status: "ok", code: res.status });
      }
      return NextResponse.json({ status: "error", code: res.status });
    } catch {
      clearTimeout(timer);
      return NextResponse.json({ status: "error" });
    }
  } catch {
    return NextResponse.json({ status: "error" }, { status: 400 });
  }
}
