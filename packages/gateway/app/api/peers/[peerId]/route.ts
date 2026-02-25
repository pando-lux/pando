import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    const { peerId } = await params;
    const node = getNodeConnection();
    const balance = await node.getBalance(peerId);
    return NextResponse.json({ peerId, balance });
  } catch {
    return NextResponse.json({ peerId: "", balance: 0 });
  }
}
