import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const { addr } = await req.json();
    if (!addr?.trim()) {
      return NextResponse.json({ error: "Multiaddr is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.connectPeer(addr.trim());
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to connect to peer" },
      { status: 500 }
    );
  }
}
