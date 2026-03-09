import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const data = await node.getResourceHealth();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ results: [], available: false });
  }
}
