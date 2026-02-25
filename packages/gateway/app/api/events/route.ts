/**
 * SSE proxy — streams real-time events from the Pando node to the browser.
 * Uses a ReadableStream with explicit chunk forwarding to ensure Next.js
 * doesn't buffer the response.
 */

import { getNodeUrl, getApiToken } from "@/lib/node-connection";

export async function GET() {
  const nodeUrl = getNodeUrl();
  const token = getApiToken();

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(`${nodeUrl}/events`, {
          headers,
          cache: "no-store",
        });

        if (!res.ok || !res.body) {
          controller.close();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              // Forward each chunk immediately — critical for SSE streaming
              controller.enqueue(value);
            }
          } catch {
            try { controller.close(); } catch {}
          }
        };

        pump();
      } catch {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Prevent Next.js from buffering the response
export const dynamic = "force-dynamic";
