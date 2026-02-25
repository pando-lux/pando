import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const node = getNodeConnection();
    const data = await node.getProposalReviewers(id);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ proposalId: id, reviewers: [], selectedReviewers: [], reviewerCount: 0, humanOnly: false });
  }
}
