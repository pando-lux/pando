import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const { proposalId, content } = await req.json();
    if (!proposalId || !content) {
      return NextResponse.json(
        { error: "proposalId and content are required" },
        { status: 400 }
      );
    }
    const node = getNodeConnection();
    const result = await node.addComment(proposalId, content);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to add comment" },
      { status: 500 }
    );
  }
}
