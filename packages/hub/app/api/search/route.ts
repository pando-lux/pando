import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const { query, identity } = await request.json();

    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    const node = getNodeConnection();
    const result = await node.search(query, identity);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        answer:
          "The Pando network could not process your query right now. Please try again.",
        sources: [],
        confidence: "none",
        respondedBy: "gateway-error",
      },
      { status: 500 }
    );
  }
}
