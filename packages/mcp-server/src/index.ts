#!/usr/bin/env node

/**
 * Pando MCP Server
 *
 * Connects Claude Code to the Pando network.
 * Talks to a local Pando node via HTTP API.
 *
 * Install:
 *   claude mcp add pando -- node /path/to/pando/packages/mcp-server/dist/index.js
 *
 * Tools:
 *   pando_status   — node status (peers, balance, supply)
 *   pando_balance  — check balance for a peer
 *   pando_transfer — send Lux to another peer
 *   pando_search   — AI search via the network
 *   pando_peers    — list connected peers
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PANDO_NODE_URL = process.env.PANDO_NODE_URL || 'http://localhost:4000';
const PANDO_API_TOKEN = process.env.PANDO_API_TOKEN || '';

/** Build headers with optional Authorization for authenticated requests. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (PANDO_API_TOKEN) {
    headers['Authorization'] = `Bearer ${PANDO_API_TOKEN}`;
  }
  return headers;
}

const server = new Server(
  { name: 'pando', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// --- List tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'pando_status',
      description: 'Get Pando node status — connected peers, Lux balance, total supply, uptime',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pando_peers',
      description: 'List all connected peers on the Pando network',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pando_balance',
      description: 'Check Lux balance for a peer ID',
      inputSchema: {
        type: 'object' as const,
        properties: {
          peerId: { type: 'string', description: 'Peer ID to check balance for. Omit for own balance.' },
        },
      },
    },
    {
      name: 'pando_transfer',
      description: 'Transfer Lux tokens to another peer on the network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Recipient peer ID' },
          amount: { type: 'number', description: 'Amount of Lux to send' },
        },
        required: ['to', 'amount'],
      },
    },
    {
      name: 'pando_search',
      description: 'Search the Pando network with AI — answers questions using contributed API keys',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'pando_wallet',
      description: 'Show wallet/ownership info — peer ID (wallet address), public key, balance, identity file location',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

// --- Handle tool calls ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'pando_status': return await handleStatus();
      case 'pando_peers': return await handlePeers();
      case 'pando_balance': return await handleBalance(args as any);
      case 'pando_transfer': return await handleTransfer(args as any);
      case 'pando_search': return await handleSearch(args as any);
      case 'pando_wallet': return await handleWallet();
      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }] };
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// --- Tool implementations ---

async function handleStatus() {
  const res = await fetch(`${PANDO_NODE_URL}/v1/status`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  const text = [
    `Pando Node Status`,
    `  Connected: ${data.connected ? 'yes' : 'no'}`,
    `  Peer ID:   ${data.peerId || 'unknown'}`,
    `  Peers:     ${data.peers}`,
    `  Balance:   ${data.balance} Lux`,
    `  Supply:    ${data.totalSupply} Lux`,
    `  Accounts:  ${data.totalAccounts}`,
    `  Uptime:    ${data.uptime}s`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text }] };
}

async function handlePeers() {
  const res = await fetch(`${PANDO_NODE_URL}/v1/peers`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  if (!data.peers || data.peers.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No peers connected.' }] };
  }

  const lines = data.peers.map((p: any) =>
    `  ${p.peerId.slice(0, 20)}... (connected ${new Date(p.connectedAt).toISOString()})`
  );

  return { content: [{ type: 'text' as const, text: `Connected peers:\n${lines.join('\n')}` }] };
}

async function handleBalance(args: { peerId?: string }) {
  // If no peerId given, get own balance from status
  if (!args.peerId) {
    const res = await fetch(`${PANDO_NODE_URL}/v1/status`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
    const data = await res.json() as any;
    return { content: [{ type: 'text' as const, text: `Your balance: ${data.balance} Lux` }] };
  }

  const res = await fetch(`${PANDO_NODE_URL}/v1/balance/${args.peerId}`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;
  return { content: [{ type: 'text' as const, text: `Balance for ${args.peerId}: ${data.balance} Lux` }] };
}

async function handleTransfer(args: { to: string; amount: number }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/transfer`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Transfer failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Transfer successful!\n  Amount: ${args.amount} Lux\n  To: ${args.to}\n  Transaction: ${data.transaction?.id || 'unknown'}`,
    }],
  };
}

async function handleSearch(args: { query: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/search`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json() as any;

  const text = [
    data.answer,
    '',
    `Sources: ${(data.sources || []).join(', ')}`,
    `Confidence: ${data.confidence}`,
    `Answered by: ${data.respondedBy}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text }] };
}

async function handleWallet() {
  const res = await fetch(`${PANDO_NODE_URL}/v1/wallet`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  const text = [
    `Pando Wallet`,
    `  Peer ID (address): ${data.peerId}`,
    `  Public Key:        ${data.publicKey}`,
    `  Balance:           ${data.balance} Lux`,
    `  Identity Created:  ${new Date(data.createdAt).toISOString()}`,
    `  Data Directory:    ${data.dataDir}`,
    `  Identity File:     ${data.ownership?.identityFile}`,
    ``,
    `Ownership: ${data.ownership?.explanation}`,
    `Backup:    ${data.ownership?.backup}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text }] };
}

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Pando MCP Server running on stdio');
  console.error(`Node URL: ${PANDO_NODE_URL}`);
}

main().catch((err) => {
  console.error('Failed to start Pando MCP Server:', err);
  process.exit(1);
});
