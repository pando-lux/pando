/**
 * SSE proxy — streams live task output from the Pando node's Scheduler.
 * Pipes /scheduler/tasks/:id/stream SSE endpoint to the browser.
 */

import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl('primary');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(
      `${NODE_URL}/v1/scheduler/tasks/${encodeURIComponent(id)}/stream`,
      {
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
      }
    );

    if (!res.ok || !res.body) {
      return new Response("Node not available", { status: 502 });
    }

    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("Node not available", { status: 502 });
  }
}

export const dynamic = "force-dynamic";
