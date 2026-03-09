import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "id parameter is required" },
        { status: 400 }
      );
    }
    const node = getNodeConnection();
    const detail = await node.getProposalDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: "Proposal not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(detail);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to get proposal" },
      { status: 500 }
    );
  }
}
