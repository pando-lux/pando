/**
 * Engine Bridge — connects @pando/node to @pando-code/core.
 *
 * Creates and configures PandoCode engine instances with:
 *   - Identity from @pando/identity (structural typing via AgentIdentity)
 *   - Budget tracking in Lux via LuxBudgetProvider
 *   - Custom Pando tools (deploy, governance, ledger, etc.)
 *
 * This is the integration layer between the 3 packages:
 *   @pando/identity → provides Ed25519 keypairs, certificates
 *   @pando-code/core → provides AI engine, tools, memory
 *   @pando/node → provides orchestration, P2P, HTTP API
 */

import { PandoCodeBackend } from './ai-backend-pandocode.js';

// ─── LuxBudgetProvider ──────────────────────────────────────────────────

/**
 * Budget provider that tracks cost in Lux instead of USD.
 * Implements @pando-code/core's BudgetProvider interface via structural typing.
 *
 * Lux conversion: witness-based emission, not market-priced.
 * For now we use a fixed conversion rate. When emission witnesses are
 * integrated, this will query the ledger for the real emission rate.
 */
export interface LuxBudgetProvider {
  currency: 'lux';
  calculateCost(usage: { model: string; inputTokens: number; outputTokens: number }): number;
}

/**
 * Create a LuxBudgetProvider.
 * @param luxPerUsdToken - Lux earned per USD-equivalent of compute work.
 *   Default: 1 Lux per $0.01 of compute (100 Lux per $1).
 */
export function createLuxBudgetProvider(luxPerUsdToken = 100): LuxBudgetProvider {
  // Model pricing (USD per token) — mirrors @pando-code/core's pricing tables
  const MODEL_PRICING: Record<string, [number, number]> = {
    'claude-opus-4-6':   [0.000015,  0.000075],
    'claude-opus-4.5':   [0.000015,  0.000075],
    'claude-opus-4':     [0.000015,  0.000075],
    'claude-sonnet-4.6': [0.000003,  0.000015],
    'claude-sonnet-4':   [0.000003,  0.000015],
    'claude-sonnet':     [0.000003,  0.000015],
    'claude-haiku':      [0.00000025, 0.00000125],
    'gpt-5.2':          [0.00000175, 0.000014],
    'gpt-5':            [0.00000125, 0.00001],
    'gpt-4o':           [0.0000025,  0.00001],
  };

  function getPrice(modelId: string): [number, number] {
    if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
    for (const key of Object.keys(MODEL_PRICING)) {
      if (modelId.startsWith(key)) return MODEL_PRICING[key];
    }
    return [0.0000025, 0.00001]; // default to gpt-4o pricing
  }

  return {
    currency: 'lux',
    calculateCost(usage) {
      const [inputPrice, outputPrice] = getPrice(usage.model);
      const usdCost = (usage.inputTokens * inputPrice) + (usage.outputTokens * outputPrice);
      return usdCost * luxPerUsdToken;
    },
  };
}

// ─── Custom Pando Tools ─────────────────────────────────────────────────

// Lazy import zod to avoid module issues — tools use it for parameter schemas
let _z: any = null;
async function getZod() {
  if (!_z) {
    const mod = await import('@pando-code/core');
    // Access zod through the module's re-exports or directly
    _z = (await import('zod')).z ?? (await import('zod'));
  }
  return _z;
}

/**
 * Create custom Pando tools for engine registration.
 * These tools give PandoCode agents access to Pando network operations.
 */
export async function createPandoTools(deps: {
  apiPort: number;
  apiToken?: string;
  nodeId?: string;
}): Promise<Array<{ name: string; description: string; parameters: any; execute: (args: any) => Promise<any> }>> {
  // We use the node's own HTTP API to execute operations.
  // This keeps the tools stateless and reuses all existing API logic.
  const baseUrl = `http://localhost:${deps.apiPort}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deps.apiToken) {
    headers['Authorization'] = `Bearer ${deps.apiToken}`;
  }

  async function apiCall(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // Dynamic zod import for tool parameter schemas
  const { z } = await import('zod');

  return [
    {
      name: 'pando_status',
      description: 'Get the current Pando node status including peers, balance, and uptime.',
      parameters: z.object({}),
      execute: async () => {
        const data = await apiCall('GET', '/v1/status');
        return { success: true, output: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: 'pando_governance_propose',
      description: 'Create a governance proposal for code changes.',
      parameters: z.object({
        title: z.string().describe('Proposal title'),
        description: z.string().describe('Proposal description'),
        type: z.enum(['upgrade', 'policy', 'budget']).default('upgrade'),
      }),
      execute: async (args: any) => {
        const data = await apiCall('POST', '/v1/governance/propose', args);
        return { success: !!data.id, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_governance_vote',
      description: 'Vote on a governance proposal.',
      parameters: z.object({
        proposalId: z.string().describe('Proposal ID to vote on'),
        vote: z.enum(['approve', 'reject']).describe('Your vote'),
      }),
      execute: async (args: any) => {
        const data = await apiCall('POST', `/v1/governance/vote`, args);
        return { success: true, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_ledger_balance',
      description: 'Check Lux balance for a peer.',
      parameters: z.object({
        peerId: z.string().optional().describe('Peer ID (default: this node)'),
      }),
      execute: async (args: any) => {
        const path = args.peerId ? `/v1/ledger/balance/${args.peerId}` : '/v1/ledger/balance';
        const data = await apiCall('GET', path);
        return { success: true, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_ledger_transfer',
      description: 'Transfer Lux to another peer.',
      parameters: z.object({
        to: z.string().describe('Recipient peer ID'),
        amount: z.number().positive().describe('Amount of Lux to transfer'),
        memo: z.string().optional().describe('Transfer memo'),
      }),
      execute: async (args: any) => {
        const data = await apiCall('POST', '/v1/ledger/transfer', args);
        return { success: true, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_deploy',
      description: 'Deploy a project to hosting (triggers governance proposal).',
      parameters: z.object({
        projectId: z.string().describe('Project ID to deploy'),
      }),
      execute: async (args: any) => {
        const data = await apiCall('POST', `/v1/projects/${args.projectId}/deploy`, {});
        return { success: true, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_peers',
      description: 'List connected P2P peers.',
      parameters: z.object({}),
      execute: async () => {
        const data = await apiCall('GET', '/v1/peers');
        return { success: true, output: JSON.stringify(data, null, 2) };
      },
    },
    {
      name: 'pando_chat_send',
      description: 'Send a message to a chat thread or project.',
      parameters: z.object({
        message: z.string().describe('Message text'),
        projectId: z.string().optional().describe('Project ID for project chat'),
      }),
      execute: async (args: any) => {
        const data = await apiCall('POST', '/v1/chat/message', args);
        return { success: true, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_network_capabilities',
      description: 'Query capabilities across all network nodes.',
      parameters: z.object({}),
      execute: async () => {
        const data = await apiCall('GET', '/v1/network/capabilities');
        return { success: true, output: JSON.stringify(data, null, 2) };
      },
    },
  ];
}

// ─── Engine Bridge ──────────────────────────────────────────────────────

export interface EngineBridgeConfig {
  apiPort: number;
  apiToken?: string;
  nodeId?: string;
  useLuxBudget?: boolean;
  luxPerUsdToken?: number;
}

/**
 * Configure a PandoCodeBackend with Pando-specific integrations.
 * Call this after creating the backend and before registering it.
 */
export async function configurePandoEngine(
  backend: PandoCodeBackend,
  config: EngineBridgeConfig,
): Promise<void> {
  // Inject Lux budget provider
  if (config.useLuxBudget !== false) {
    const provider = createLuxBudgetProvider(config.luxPerUsdToken);
    backend.setBudgetProvider(provider);
  }

  // Register custom Pando tools
  const tools = await createPandoTools({
    apiPort: config.apiPort,
    apiToken: config.apiToken,
    nodeId: config.nodeId,
  });

  for (const tool of tools) {
    backend.registerCustomTool(tool);
  }
}
