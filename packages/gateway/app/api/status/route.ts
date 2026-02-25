import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const status = await node.getStatusAsync();
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({
      connected: false,
      peers: 0,
      identity: "",
      balance: 0,
      totalSupply: 0,
      totalAccounts: 0,
    });
  }
}
