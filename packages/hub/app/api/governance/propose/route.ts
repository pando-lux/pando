import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(req: Request) {
  try {
    const userToken = req.headers.get("X-User-Token");
    if (!userToken) {
      return NextResponse.json(
        { error: "Authentication required to participate in governance" },
        { status: 401 }
      );
    }
    const { title, description } = await req.json();
    if (!title?.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.createProposal(title.trim(), description?.trim() || "");
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to create proposal" },
      { status: 500 }
    );
  }
}
