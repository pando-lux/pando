import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const { proposalId, choice, reasoning } = await req.json();
    if (!proposalId || !choice) {
      return NextResponse.json(
        { error: "proposalId and choice are required" },
        { status: 400 }
      );
    }
    const node = getNodeConnection();
    const result = await node.voteOnProposal(proposalId, choice, reasoning);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to vote" },
      { status: 500 }
    );
  }
}
