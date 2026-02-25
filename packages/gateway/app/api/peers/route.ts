import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const peers = await node.getPeers();
    return NextResponse.json({ peers });
  } catch {
    return NextResponse.json({ peers: [] });
  }
}
