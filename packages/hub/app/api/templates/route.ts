import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const templates = await node.getTemplates();
    return NextResponse.json({ templates });
  } catch {
    return NextResponse.json({ templates: [] });
  }
}
