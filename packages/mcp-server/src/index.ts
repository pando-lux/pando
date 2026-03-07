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
 *   pando_status           — node status (peers, balance, supply)
 *   pando_balance          — check balance for a peer
 *   pando_transfer         — send Lux to another peer
 *   pando_search           — AI search via the network
 *   pando_peers            — list connected peers
 *   pando_wallet           — wallet/ownership info
 *   pando_deploy           — deploy a project
 *   pando_list_projects    — list all projects
 *   pando_create_project   — create a new project
 *   pando_governance_propose — submit a governance proposal
 *   pando_governance_vote  — vote on a governance proposal
 *   pando_broadcast        — broadcast a message to the network
 *   pando_test_run         — run E2E tests
 *   pando_test_status      — get testing status
 *   pando_save_memory      — save a lesson to memory
 *   pando_board_update     — update a board task
 *   pando_board_create     — create a board task
 *   pando_send_message     — send a message to an agent
 *   pando_check_inbox      — check agent inbox
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
    // --- Existing tools ---
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
    // --- New tools ---
    {
      name: 'pando_deploy',
      description: 'Deploy a project to the Pando network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          projectId: { type: 'string', description: 'Project ID to deploy' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'pando_list_projects',
      description: 'List all projects on the Pando network',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pando_create_project',
      description: 'Create a new project on the Pando network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Project description' },
          visibility: { type: 'string', description: 'Visibility: public or private' },
        },
        required: ['name'],
      },
    },
    {
      name: 'pando_governance_propose',
      description: 'Submit a governance proposal to the Pando network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Proposal title' },
          description: { type: 'string', description: 'Proposal description' },
        },
        required: ['title', 'description'],
      },
    },
    {
      name: 'pando_governance_vote',
      description: 'Vote on a governance proposal',
      inputSchema: {
        type: 'object' as const,
        properties: {
          proposalId: { type: 'string', description: 'Proposal ID to vote on' },
          vote: { type: 'string', description: 'Vote value (e.g. "yes", "no", "abstain")' },
        },
        required: ['proposalId', 'vote'],
      },
    },
    {
      name: 'pando_broadcast',
      description: 'Broadcast a message to the Pando network on a topic',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Topic to broadcast on' },
          message: { type: 'string', description: 'Message to broadcast' },
        },
        required: ['topic', 'message'],
      },
    },
    {
      name: 'pando_test_run',
      description: 'Run E2E tests on the Pando network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Project to test (optional)' },
          spec: { type: 'string', description: 'Specific spec file to run (optional)' },
        },
      },
    },
    {
      name: 'pando_test_status',
      description: 'Get current testing status and results',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pando_save_memory',
      description: 'Save a lesson or insight to persistent memory',
      inputSchema: {
        type: 'object' as const,
        properties: {
          lesson: { type: 'string', description: 'The lesson or insight to save' },
          category: { type: 'string', description: 'Category for the memory (optional)' },
          projectId: { type: 'string', description: 'Associated project ID (optional)' },
        },
        required: ['lesson'],
      },
    },
    {
      name: 'pando_board_update',
      description: 'Update a board task status or progress',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID to update' },
          status: { type: 'string', description: 'New status (e.g. "in-progress", "done")' },
          progress: { type: 'string', description: 'Progress description' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'pando_board_create',
      description: 'Create a new board task',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Task description (optional)' },
          projectId: { type: 'string', description: 'Associated project ID (optional)' },
        },
        required: ['title'],
      },
    },
    {
      name: 'pando_send_message',
      description: 'Send a message to another agent on the Pando network',
      inputSchema: {
        type: 'object' as const,
        properties: {
          toAgentId: { type: 'string', description: 'Agent ID to send the message to' },
          message: { type: 'string', description: 'Message content' },
        },
        required: ['toAgentId', 'message'],
      },
    },
    {
      name: 'pando_check_inbox',
      description: 'Check the agent message inbox',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agentId: { type: 'string', description: 'Agent ID to check inbox for (optional, defaults to self)' },
        },
      },
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
      case 'pando_deploy': return await handleDeploy(args as any);
      case 'pando_list_projects': return await handleListProjects();
      case 'pando_create_project': return await handleCreateProject(args as any);
      case 'pando_governance_propose': return await handleGovernancePropose(args as any);
      case 'pando_governance_vote': return await handleGovernanceVote(args as any);
      case 'pando_broadcast': return await handleBroadcast(args as any);
      case 'pando_test_run': return await handleTestRun(args as any);
      case 'pando_test_status': return await handleTestStatus();
      case 'pando_save_memory': return await handleSaveMemory(args as any);
      case 'pando_board_update': return await handleBoardUpdate(args as any);
      case 'pando_board_create': return await handleBoardCreate(args as any);
      case 'pando_send_message': return await handleSendMessage(args as any);
      case 'pando_check_inbox': return await handleCheckInbox(args as any);
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

// --- Tool implementations (existing) ---

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

// --- Tool implementations (new) ---

async function handleDeploy(args: { projectId: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/projects/${args.projectId}/deploy`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Deploy failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Deploy initiated for project ${args.projectId}\n  Status: ${data.status || 'started'}\n  Deploy ID: ${data.deployId || data.id || 'unknown'}`,
    }],
  };
}

async function handleListProjects() {
  const res = await fetch(`${PANDO_NODE_URL}/v1/projects`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  const projects = data.projects || data || [];
  if (!Array.isArray(projects) || projects.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No projects found.' }] };
  }

  const lines = projects.map((p: any) =>
    `  ${p.name || p.id} — ${p.description || 'no description'} (${p.visibility || 'public'})`
  );

  return { content: [{ type: 'text' as const, text: `Projects:\n${lines.join('\n')}` }] };
}

async function handleCreateProject(args: { name: string; description?: string; visibility?: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/projects`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Project creation failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Project created!\n  Name: ${args.name}\n  ID: ${data.id || data.projectId || 'unknown'}\n  Visibility: ${args.visibility || 'public'}`,
    }],
  };
}

async function handleGovernancePropose(args: { title: string; description: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/governance/propose`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Proposal submission failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Governance proposal submitted!\n  Title: ${args.title}\n  Proposal ID: ${data.proposalId || data.id || 'unknown'}`,
    }],
  };
}

async function handleGovernanceVote(args: { proposalId: string; vote: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/governance/vote`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Vote failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Vote recorded!\n  Proposal: ${args.proposalId}\n  Vote: ${args.vote}\n  Result: ${data.status || 'accepted'}`,
    }],
  };
}

async function handleBroadcast(args: { topic: string; message: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/broadcast`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Broadcast failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Message broadcast!\n  Topic: ${args.topic}\n  Reached: ${data.recipients || data.reached || 'unknown'} peers`,
    }],
  };
}

async function handleTestRun(args: { project?: string; spec?: string }) {
  const body: Record<string, string> = {};
  if (args.project) body.project = args.project;
  if (args.spec) body.spec = args.spec;

  const res = await fetch(`${PANDO_NODE_URL}/v1/testing/run`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Test run failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Test run started!\n  Run ID: ${data.runId || data.id || 'unknown'}\n  Project: ${args.project || 'all'}\n  Spec: ${args.spec || 'all'}\n  Status: ${data.status || 'running'}`,
    }],
  };
}

async function handleTestStatus() {
  const res = await fetch(`${PANDO_NODE_URL}/v1/testing/status`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  const text = [
    `Testing Status`,
    `  Status: ${data.status || 'unknown'}`,
    `  Total:  ${data.total ?? 'unknown'}`,
    `  Passed: ${data.passed ?? 'unknown'}`,
    `  Failed: ${data.failed ?? 'unknown'}`,
    `  Running: ${data.running ?? 'unknown'}`,
  ].join('\n');

  return { content: [{ type: 'text' as const, text }] };
}

async function handleSaveMemory(args: { lesson: string; category?: string; projectId?: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/memory/save`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Memory save failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Memory saved!\n  Category: ${args.category || 'general'}\n  Project: ${args.projectId || 'none'}\n  ID: ${data.id || data.memoryId || 'unknown'}`,
    }],
  };
}

async function handleBoardUpdate(args: { taskId: string; status?: string; progress?: string }) {
  const body: Record<string, string> = {};
  if (args.status) body.status = args.status;
  if (args.progress) body.progress = args.progress;

  const res = await fetch(`${PANDO_NODE_URL}/v1/board/tasks/${args.taskId}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Board task update failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Board task updated!\n  Task ID: ${args.taskId}\n  Status: ${args.status || 'unchanged'}\n  Progress: ${args.progress || 'unchanged'}`,
    }],
  };
}

async function handleBoardCreate(args: { title: string; description?: string; projectId?: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/board/tasks`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Board task creation failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Board task created!\n  Title: ${args.title}\n  Task ID: ${data.id || data.taskId || 'unknown'}\n  Project: ${args.projectId || 'none'}`,
    }],
  };
}

async function handleSendMessage(args: { toAgentId: string; message: string }) {
  const res = await fetch(`${PANDO_NODE_URL}/v1/agents/message`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.json() as any;
    throw new Error(error.error || 'Message send failed');
  }

  const data = await res.json() as any;
  return {
    content: [{
      type: 'text' as const,
      text: `Message sent!\n  To: ${args.toAgentId}\n  Message ID: ${data.id || data.messageId || 'unknown'}`,
    }],
  };
}

async function handleCheckInbox(args: { agentId?: string }) {
  const url = args.agentId
    ? `${PANDO_NODE_URL}/v1/agents/inbox?agentId=${encodeURIComponent(args.agentId)}`
    : `${PANDO_NODE_URL}/v1/agents/inbox`;

  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
  const data = await res.json() as any;

  const messages = data.messages || data || [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No messages in inbox.' }] };
  }

  const lines = messages.map((m: any) =>
    `  [${m.from || 'unknown'}] ${m.message || m.content || m.text || JSON.stringify(m)}`
  );

  return { content: [{ type: 'text' as const, text: `Inbox (${messages.length} messages):\n${lines.join('\n')}` }] };
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
