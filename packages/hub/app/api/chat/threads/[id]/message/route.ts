import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

function nodeHeaders(request?: Request): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getApiToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Forward user session token so the node can resolve user identity for quick-tier responses
  if (request) {
    const userToken = request.headers.get("X-User-Token");
    if (userToken) headers["X-User-Token"] = userToken;
  }
  return headers;
}

// POST /api/chat/threads/[id]/message — send message in a thread
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json(
        { error: "Message is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Route to the node's thread message endpoint (saves to ThreadStore + bridges to agent)
    // Phase 41/41.5: Forward encrypted/nonce/encryptedThreadKey fields for E2E encrypted messages
    const forwardBody: Record<string, unknown> = {
      message: body.message,
      tier: body.tier,
    };
    if (body.encrypted) forwardBody.encrypted = true;
    if (body.nonce) forwardBody.nonce = body.nonce;
    // Phase 41.5: Per-request thread key delivery (stateless node)
    if (body.encryptedThreadKey) forwardBody.encryptedThreadKey = body.encryptedThreadKey;

    const res = await fetchFromNode(`/v1/chat/threads/${encodeURIComponent(id)}/message`, {
      method: "POST",
      headers: nodeHeaders(request),
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(30000),
    }, 'primary');

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Node error" }));
      return NextResponse.json(error, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({
      reply: data.reply || "Message received. Processing...",
      tier: data.tier || "complex",
      status: data.status,
      threadId: id,
      // Phase 41: Forward encryption metadata for encrypted responses
      encrypted: data.encrypted || false,
      nonce: data.nonce || undefined,
    });
  } catch (err: any) {
    console.error("POST /api/chat/threads/[id]/message error:", err?.message);
    return NextResponse.json(
      { error: "Failed to send message", details: err?.message },
      { status: 500 },
    );
  }
}
