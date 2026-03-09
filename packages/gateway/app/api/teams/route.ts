import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const teams = await node.getTeams();
    return NextResponse.json({ teams });
  } catch {
    return NextResponse.json({ teams: [] });
  }
}
