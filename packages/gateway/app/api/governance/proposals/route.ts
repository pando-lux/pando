import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const proposals = await node.getProposals();
    return NextResponse.json({ proposals });
  } catch {
    return NextResponse.json({ proposals: [] });
  }
}
