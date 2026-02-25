import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  try {
    const { username } = await params;
    const headers: Record<string, string> = {};
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(
      `${getNodeUrl()}/network/capabilities/user/${encodeURIComponent(username)}`,
      { headers, cache: "no-store" },
    );
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ count: 0, profiles: [] });
  }
}
