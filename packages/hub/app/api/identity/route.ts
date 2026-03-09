import { NextResponse } from "next/server";
import { getNodeConnection, getNodeUrl } from "@/lib/node-connection";

export async function GET() {
  try {
    const node = getNodeConnection();
    const [status, wallet] = await Promise.all([
      node.getStatusAsync(),
      fetchWallet(node),
    ]);

    return NextResponse.json({
      current: {
        peerId: wallet.peerId || status.identity || "",
        publicKey: wallet.publicKey || "",
        balance: wallet.balance ?? status.balance ?? 0,
        createdAt: wallet.createdAt || null,
        accountCreatedAt: wallet.accountCreatedAt || null,
        recentTransactions: wallet.recentTransactions || 0,
        dataDir: wallet.dataDir || "",
        encrypted: wallet.encrypted ?? null,
        identityFile: wallet.ownership?.identityFile || "",
      },
      peers: status.peers || 0,
      connected: !!status.identity,
    });
  } catch {
    return NextResponse.json({
      current: null,
      peers: 0,
      connected: false,
    });
  }
}

async function fetchWallet(node: any): Promise<any> {
  try {
    const nodeUrl = getNodeUrl();
    const res = await fetch(`${nodeUrl}/v1/wallet`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("Failed to get wallet");
    return await res.json();
  } catch {
    return {};
  }
}
