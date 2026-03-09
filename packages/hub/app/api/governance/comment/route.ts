import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const userToken = req.headers.get("X-User-Token");
    if (!userToken) {
      return NextResponse.json(
        { error: "Authentication required to participate in governance" },
        { status: 401 }
      );
    }
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
