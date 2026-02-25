import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50");

    // Extract user token from the request to forward to the node
    const authHeader = request.headers.get("authorization") || "";
    const userToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : request.headers.get("x-user-token") || "";

    const node = getNodeConnection();
    const data = await node.getTransactions(limit, userToken || undefined);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ transactions: [], peerId: "" });
  }
}
