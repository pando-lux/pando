import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

/**
 * Ledger Explorer API — proxy to node /v1/ledger/*
 * GET /api/ledger?type=accounts&limit=50 — top accounts
 * GET /api/ledger?type=transactions&limit=50 — recent transactions
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "accounts";
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
    const node = getNodeConnection();

    if (type === "transactions") {
      const data = await node.getLedgerTransactions(limit);
      return NextResponse.json(data);
    } else {
      const data = await node.getLedgerAccounts(limit);
      return NextResponse.json(data);
    }
  } catch {
    return NextResponse.json({ accounts: [], transactions: [], total: 0 });
  }
}
