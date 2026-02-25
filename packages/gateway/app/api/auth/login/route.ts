import { NextResponse } from "next/server";
import { fetchFromNode } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const res = await fetchFromNode("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    // Guard against non-JSON responses (e.g. node returned HTML error page)
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      return NextResponse.json(
        { error: "Login failed", details: text.slice(0, 200) },
        { status: res.status >= 400 ? res.status : 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    const message = err?.name === "TimeoutError"
      ? "Login request timed out — node may be slow or unreachable"
      : err?.message || "Failed to login";
    return NextResponse.json(
      { error: "Failed to login", details: message },
      { status: 504 },
    );
  }
}
