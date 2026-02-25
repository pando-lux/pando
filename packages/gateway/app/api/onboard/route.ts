import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const onboard = await node.getOnboard();
    return NextResponse.json(onboard);
  } catch {
    return NextResponse.json({
      bootstrapAddrs: [],
      instructions: "",
      version: "",
      peerId: "",
      peerCount: 0,
    });
  }
}
