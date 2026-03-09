import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const { message, tier, sessionId, projectId } = await request.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (message.length > 2000) {
      return NextResponse.json(
        { error: "Message too long (max 2000 characters)", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    // Forward user session token so the node can resolve user identity for quick-tier responses
    const userToken = request.headers.get("X-User-Token");
    if (userToken) {
      headers["X-User-Token"] = userToken;
    }

    // Complex tier uses Claude Code which can take up to 2 minutes
    const timeout = tier === "complex" ? 150000 : 30000;

    const res = await fetchFromNode("/v1/chat/message", {
      method: "POST",
      headers,
      body: JSON.stringify({ message, tier, sessionId, projectId }),
      signal: AbortSignal.timeout(timeout),
    }, 'any');

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Node error" }));
      return NextResponse.json(error, { status: res.status });
    }

    return NextResponse.json(await res.json());
  } catch (err: any) {
    console.error("POST /api/chat/message error:", err?.message || err);
    return NextResponse.json(
      { error: "Failed to send message", code: "CHAT_FAILED", details: err?.message || "Unknown error" },
      { status: 500 },
    );
  }
}
