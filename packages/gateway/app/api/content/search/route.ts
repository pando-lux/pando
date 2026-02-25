import { NextResponse } from "next/server";
import { getNodeUrl } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams.toString();
    const res = await fetch(`${NODE_URL}/content/search${params ? `?${params}` : ""}`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ results: [] });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ results: [] });
  }
}
