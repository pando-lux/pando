import { NextResponse, NextRequest } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.submitTeamRequest(id, body.message);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to submit request" }, { status: 400 });
  }
}
