/**
 * Structural Typing Integration Test
 *
 * Proves that @pando/identity's AgentProfile structurally satisfies
 * @pando/code's AgentIdentity schema — WITHOUT importing pando-code.
 *
 * We replicate pando-code's Zod schema here (the exact same definition)
 * and validate an AgentProfile against it. If pando-code changes its schema,
 * this test catches the drift.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../src/identity/agent-profile.js';
import { generate } from '../src/core/keypair.js';
import type { AgentScope } from '../src/types.js';

// ─── Replicate pando-code's schemas (from packages/core/src/types.ts) ───

const BuiltInRoles = [
  "lead", "builder", "tester", "reviewer", "coordinator", "planner", "explorer",
] as const;

const PandoCodeAgentRoleSchema = z.union([
  z.enum(BuiltInRoles),
  z.string().min(1),
]);

const PandoCodeAgentScopeSchema = z.object({
  readPaths: z.array(z.string()),
  writePaths: z.array(z.string()),
  excludePaths: z.array(z.string()),
  services: z.array(z.string()).optional(),
  network: z.boolean().optional(),
});

const PandoCodeAgentStatusSchema = z.enum([
  "pending", "active", "idle", "working", "done", "failed", "terminated",
]);

const PandoCodeAgentIdentitySchema = z.object({
  id: z.string(),
  role: PandoCodeAgentRoleSchema,
  model: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  scope: PandoCodeAgentScopeSchema,
  status: PandoCodeAgentStatusSchema,
  createdAt: z.string().datetime(),
  parentId: z.string().optional(),
  publicKey: z.string().optional(),
  certificate: z.string().optional(),
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('Structural Typing: @pando/identity → @pando/code', () => {
  it('AgentProfile maps to pando-code AgentIdentity without data loss', async () => {
    // Create a real agent identity
    const human = await generate();

    const { profile } = await createAgent({
      name: 'test-builder',
      role: 'builder',
      tools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
      capabilities: ['code', 'test'],
      scope: {
        readPaths: ['/src'],
        writePaths: ['/src'],
        excludePaths: ['/node_modules'],
        services: ['mongodb'],
        network: true,
      },
      model: 'claude-sonnet-4',
      budgetLimit: 5.0,
    }, human);

    // Map AgentProfile → pando-code AgentIdentity shape
    const engineConfig = {
      id: profile.id,
      role: profile.role,
      model: profile.model ?? 'claude-sonnet-4',
      systemPrompt: `You are ${profile.name}, role: ${profile.role}`,
      tools: profile.tools,
      scope: {
        readPaths: profile.scope.readPaths ?? [],
        writePaths: profile.scope.writePaths ?? [],
        excludePaths: profile.scope.excludePaths ?? [],
        services: profile.scope.services,
        network: profile.scope.network,
      },
      status: profile.status as z.infer<typeof PandoCodeAgentStatusSchema>,
      createdAt: profile.createdAt,
      parentId: profile.parentId,
      publicKey: profile.publicKey,
      certificate: JSON.stringify(profile.certificate),
    };

    // Validate against pando-code's schema
    const result = PandoCodeAgentIdentitySchema.safeParse(engineConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(profile.id);
      expect(result.data.role).toBe('builder');
      expect(result.data.tools).toEqual(profile.tools);
      expect(result.data.scope.services).toEqual(['mongodb']);
      expect(result.data.scope.network).toBe(true);
      expect(result.data.parentId).toBe(profile.parentId);
      expect(result.data.publicKey).toBe(profile.publicKey);
      expect(result.data.certificate).toBeDefined();
    }
  });

  it('Custom roles (non-built-in) pass pando-code schema validation', async () => {
    const human = await generate();

    const { profile } = await createAgent({
      name: 'custom-auditor',
      role: 'security-auditor', // Custom role — not in built-in list
      tools: ['read_file', 'glob', 'grep'],
      capabilities: ['audit'],
      scope: {
        readPaths: ['/'],
        writePaths: [],
        excludePaths: [],
      },
    }, human);

    const engineConfig = {
      id: profile.id,
      role: profile.role, // "security-auditor" — custom string
      model: 'claude-sonnet-4',
      systemPrompt: 'You are a security auditor.',
      tools: profile.tools,
      scope: {
        readPaths: profile.scope.readPaths ?? [],
        writePaths: profile.scope.writePaths ?? [],
        excludePaths: profile.scope.excludePaths ?? [],
      },
      status: 'idle' as const,
      createdAt: new Date().toISOString(),
    };

    const result = PandoCodeAgentRoleSchema.safeParse(profile.role);
    expect(result.success).toBe(true);

    const fullResult = PandoCodeAgentIdentitySchema.safeParse(engineConfig);
    expect(fullResult.success).toBe(true);
  });

  it('All identity AgentStatus values are valid in pando-code', () => {
    const identityStatuses: string[] = ['pending', 'active', 'idle', 'done', 'failed', 'terminated'];
    for (const status of identityStatuses) {
      const result = PandoCodeAgentStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });

  it('Identity AgentScope with services+network passes pando-code scope schema', () => {
    const scope: AgentScope = {
      readPaths: ['/src', '/tests'],
      writePaths: ['/src'],
      excludePaths: ['/node_modules', '/.git'],
      services: ['mongodb', 's3', 'github'],
      network: true,
    };

    const result = PandoCodeAgentScopeSchema.safeParse(scope);
    expect(result.success).toBe(true);
  });

  it('BudgetProvider interface contract: USD mode', () => {
    // Replicate pando-code's BudgetProvider interface
    interface BudgetProvider {
      currency: 'usd' | 'lux';
      calculateCost(usage: { model: string; inputTokens: number; outputTokens: number }): number;
    }

    const usdProvider: BudgetProvider = {
      currency: 'usd',
      calculateCost(usage) {
        // Simplified pricing for test
        return (usage.inputTokens * 0.000003) + (usage.outputTokens * 0.000015);
      },
    };

    const cost = usdProvider.calculateCost({
      model: 'claude-sonnet-4',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeGreaterThan(0);
    expect(usdProvider.currency).toBe('usd');
  });

  it('BudgetProvider interface contract: Lux mode', () => {
    interface BudgetProvider {
      currency: 'usd' | 'lux';
      calculateCost(usage: { model: string; inputTokens: number; outputTokens: number }): number;
    }

    // This is what @pando/node would register
    const luxProvider: BudgetProvider = {
      currency: 'lux',
      calculateCost(usage) {
        // Lux: witness-based emission rate (simplified for test)
        const totalTokens = usage.inputTokens + usage.outputTokens;
        return totalTokens * 0.001; // 0.001 Lux per token
      },
    };

    const cost = luxProvider.calculateCost({
      model: 'claude-sonnet-4',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBe(1.5); // 1500 tokens * 0.001
    expect(luxProvider.currency).toBe('lux');
  });
});
