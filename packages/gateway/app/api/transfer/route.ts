import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const { to, amount } = await req.json();
    if (!to?.trim()) {
      return NextResponse.json({ error: "Recipient peer ID is required" }, { status: 400 });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
    }

    // Extract user token from the request to forward to the node
    const authHeader = req.headers.get("authorization") || "";
    const userToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.headers.get("x-user-token") || "";

    const node = getNodeConnection();
    const result = await node.transfer(to.trim(), amount, userToken || undefined);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Transfer failed" },
      { status: 500 }
    );
  }
}
