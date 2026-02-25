import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "30");
    const node = getNodeConnection();
    const data = await node.getActivity(limit);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ events: [], nodeId: "" });
  }
}
