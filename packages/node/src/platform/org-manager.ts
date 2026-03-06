/**
 * OrgManager — Manages the orchestrator hierarchy.
 *
 * Responsibilities:
 *   - Create and dissolve orchestrators
 *   - Maintain the hierarchy tree (parent/child relationships)
 *   - Route cross-team messages through the hierarchy
 *   - Council selection (top reputation nodes with AI capability)
 *   - Authority inheritance (children can never exceed parent's authority)
 *   - Find or create project orchestrators
 *
 * Does NOT:
 *   - Run tick loops (that's the Orchestrator class)
 *   - Manage worker processes (that's WorkerPool)
 *   - Handle message persistence (that's MessageBus)
 */

import { randomUUID } from 'node:crypto';
import type { AgentDatabase, AgentIdentity, AgentScope } from './agent-database.js';
import type { MessageBus } from '../core/message-bus.js';
import type { WorkerPool } from '../core/worker-pool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  role: string;                    // 'council', 'engineering', 'qa', 'user_project', etc.
  level?: number;                  // 0=council, 1=dept, 2=team
  parentId?: string;               // null = top-level
  projectId?: string;
  scope?: AgentScope;
  nodeId?: string;
  tickIntervalMs?: number;         // default: 60000
  maxWorkers?: number;             // default: 10
  maxChildren?: number;            // default: 5
  rolePrompt?: string;             // AI brain prompt for this orchestrator
  authority?: Record<string, unknown>;
  persistent?: boolean;            // survive across sessions?
}

export interface OrgTree {
  id: string;
  role: string;
  type: string;
  status: string;
  level: number;
  children: OrgTree[];
  workers: Array<{
    id: string;
    role: string;
    status: string;
    taskId: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Authority helpers
// ---------------------------------------------------------------------------

/**
 * Narrow authority: child can never exceed parent's authority.
 * If parent doesn't have a field, child can't have it either.
 */
export function narrowAuthority(
  parentAuth: Record<string, any> | null,
  childAuth: Record<string, any> | null,
): Record<string, any> {
  if (!parentAuth) return childAuth || {};
  if (!childAuth) return parentAuth;

  const result: Record<string, any> = {};

  // Files
  if (parentAuth.files || childAuth.files) {
    result.files = {
      read: childAuth.files?.read || parentAuth.files?.read || ['**'],
      write: childAuth.files?.write || parentAuth.files?.write || [],
      forbidden: [
        ...(parentAuth.files?.forbidden || []),
        ...(childAuth.files?.forbidden || []),
      ],
    };
  }

  // Commands
  if (parentAuth.commands || childAuth.commands) {
    result.commands = {
      allowed: childAuth.commands?.allowed || parentAuth.commands?.allowed || [],
      forbidden: [
        ...(parentAuth.commands?.forbidden || []),
        ...(childAuth.commands?.forbidden || []),
      ],
    };
  }

  // Agents
  result.agents = {
    canSpawn: (parentAuth.agents?.canSpawn ?? true) && (childAuth.agents?.canSpawn ?? true),
    maxWorkers: Math.min(
      parentAuth.agents?.maxWorkers ?? 10,
      childAuth.agents?.maxWorkers ?? 10,
    ),
    maxBudget: Math.min(
      parentAuth.agents?.maxBudget ?? 1000,
      childAuth.agents?.maxBudget ?? 1000,
    ),
  };

  return result;
}

// ---------------------------------------------------------------------------
// OrgManager class
// ---------------------------------------------------------------------------

export class OrgManager {
  constructor(
    private db: AgentDatabase,
    private workerPool: WorkerPool,
    private messageBus: MessageBus,
  ) {}

  /**
   * Create a new orchestrator in the hierarchy.
   */
  createOrchestrator(config: OrchestratorConfig): string {
    const orchestratorId = `orch-${config.role}-${randomUUID().slice(0, 8)}`;

    // Authority inheritance: narrow from parent
    let authority = config.authority || null;
    if (config.parentId) {
      const parent = this.db.getAgent(config.parentId);
      if (parent) {
        const parentAuth = parent.authority ? JSON.parse(parent.authority) : null;
        authority = narrowAuthority(parentAuth, config.authority || null);
      }
    }

    // Determine level from parent + enforce max depth
    const MAX_HIERARCHY_DEPTH = 5;
    let level = config.level ?? 0;
    if (config.parentId && level === 0) {
      const parent = this.db.getAgent(config.parentId);
      if (parent && parent.tickIntervalMs !== null) {
        // Parent is an orchestrator, infer level
        let depth = 0;
        let current: AgentIdentity | null = parent;
        while (current?.parentId) {
          depth++;
          current = this.db.getAgent(current.parentId);
        }
        level = depth + 1;
      }
    }
    if (level >= MAX_HIERARCHY_DEPTH) {
      throw new Error(`Cannot create orchestrator: max hierarchy depth (${MAX_HIERARCHY_DEPTH}) reached at level ${level}`);
    }

    // Enforce maxChildren on parent
    if (config.parentId) {
      const parent = this.db.getAgent(config.parentId);
      if (parent && parent.maxChildren) {
        const existingChildren = this.db.getChildren(config.parentId)
          .filter(c => c.type === 'orchestrator' && c.status === 'active');
        if (existingChildren.length >= parent.maxChildren) {
          throw new Error(`Cannot create orchestrator: parent ${config.parentId} already has ${existingChildren.length}/${parent.maxChildren} child orchestrators`);
        }
      }
    }

    this.db.createAgent({
      id: orchestratorId,
      role: config.role,
      type: 'orchestrator',
      scope: config.scope || 'public',
      parentId: config.parentId || null,
      nodeId: config.nodeId || null,
      status: 'active',
      authority: authority ? JSON.stringify(authority) : null,
      fileScope: null,
      budgetLimit: (config.authority?.agents as any)?.maxBudget ?? 1000,
      projectId: config.projectId || null,
      workspaceDir: null,
      currentTaskId: null,
      rolePrompt: config.rolePrompt || null,
      contextVersion: null,
      sessionId: null,
      pid: null,
      persistent: config.persistent ?? true,
      tickIntervalMs: config.tickIntervalMs ?? 60000,
      lastTickAt: null,
      maxWorkers: config.maxWorkers ?? 10,
      maxChildren: config.maxChildren ?? 5,
      lastReportAt: null,
      exitCode: null,
      errorSummary: null,
      failedAt: null,
      templateId: 'builtin:manager',
    });

    return orchestratorId;
  }

  /**
   * Dissolve an orchestrator: kill workers, save lessons, clean up.
   */
  dissolve(orchestratorId: string): void {
    const orch = this.db.getAgent(orchestratorId);
    if (!orch) return;

    // Kill all workers owned by this orchestrator
    const workers = this.db.getActiveWorkers(orchestratorId);
    for (const worker of workers) {
      this.workerPool?.kill(worker.id);
    }

    // Dissolve child orchestrators recursively
    const children = this.db.getChildren(orchestratorId);
    for (const child of children) {
      if (child.type === 'orchestrator' && child.status !== 'dissolved') {
        this.dissolve(child.id);
      }
    }

    // Promote lessons to org_knowledge (institutional memory)
    const lessons = this.db.getLessons({ orchestratorId, minConfidence: 0.7 });
    for (const lesson of lessons) {
      if (lesson.timesUsed >= 3) {
        this.db.addOrgKnowledge({
          category: orch.role,
          knowledge: lesson.lesson,
          source: orchestratorId,
          relevanceTags: lesson.relevanceTags ? JSON.parse(lesson.relevanceTags) : undefined,
        });
      }
    }

    // Mark as dissolved
    this.db.updateAgent(orchestratorId, { status: 'dissolved' });

    // Notify parent
    if (orch.parentId) {
      this.messageBus.send({
        recipientId: orch.parentId,
        senderId: orchestratorId,
        senderType: 'orchestrator',
        type: 'worker_report',
        payload: { status: 'dissolved', summary: `Orchestrator ${orch.role} dissolved` },
      });
    }
  }

  /**
   * Get the full hierarchy tree, optionally from a specific root.
   */
  getTree(rootId?: string): OrgTree[] {
    const agents = this.db.getTree(rootId);

    // Build tree structure
    const nodeMap = new Map<string, OrgTree>();
    const roots: OrgTree[] = [];

    // First pass: create nodes for orchestrators
    for (const agent of agents) {
      if (agent.type === 'orchestrator') {
        const node: OrgTree = {
          id: agent.id,
          role: agent.role,
          type: agent.type,
          status: agent.status,
          level: 0, // calculated below
          children: [],
          workers: [],
        };
        nodeMap.set(agent.id, node);
      }
    }

    // Second pass: attach workers and build hierarchy
    for (const agent of agents) {
      if (agent.type === 'worker' && agent.parentId) {
        const parent = nodeMap.get(agent.parentId);
        if (parent) {
          parent.workers.push({
            id: agent.id,
            role: agent.role,
            status: agent.status,
            taskId: agent.currentTaskId,
          });
        }
      }
      if (agent.type === 'orchestrator') {
        const node = nodeMap.get(agent.id)!;
        if (agent.parentId && nodeMap.has(agent.parentId)) {
          nodeMap.get(agent.parentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }

    // Calculate levels
    function setLevels(nodes: OrgTree[], level: number) {
      for (const node of nodes) {
        node.level = level;
        setLevels(node.children, level + 1);
      }
    }
    setLevels(roots, 0);

    return roots;
  }

  /**
   * Find or create a project orchestrator.
   */
  getOrchestratorForProject(projectId: string, opts?: { scope?: AgentScope; parentId?: string }): string {
    // Check if one already exists (active or pending from restart)
    const existing = this.db.listAgents({ projectId, type: 'orchestrator' })
      .find(a => a.status === 'active' || a.status === 'pending');

    if (existing) {
      // Reactivate if pending (survived restart)
      if (existing.status === 'pending') {
        this.db.updateAgent(existing.id, { status: 'active' });
      }
      return existing.id;
    }

    // Create a new project orchestrator
    return this.createOrchestrator({
      role: 'user_project',
      projectId,
      scope: opts?.scope || 'private',
      parentId: opts?.parentId,
      tickIntervalMs: 30000,  // faster ticks for user projects
      maxWorkers: 5,
      persistent: true,       // Phase 104: persist as long as node is alive
      rolePrompt: `You are the project manager for a user's application.
Your job: read the user's request, plan the approach, spawn builder workers to write code,
spawn tester workers for QA, then commit and deploy.

Pipeline: builder writes code → tester verifies → commit_code → deploy
- commit_code: commits changes in the project workspace, pushes to GitHub
- deploy: deploys to live hosting (S3 for static, PM2+nginx for server apps)

When the user's request is fulfilled:
1. commit_code with a descriptive message
2. deploy with the project ID
3. respond_to_user with the live URL

If QA fails, send failure details back to the builder. Max 3 retries.
If stuck, escalate to the council orchestrator.`,
    });
  }

  /**
   * Select council members (top reputation nodes with AI capability).
   * Returns node IDs (peer IDs) that should run the council orchestrator.
   *
   * For dev mode: returns the local node as the only council member.
   */
  selectCouncil(localNodeId: string, _reputationScores?: Map<string, number>): string[] {
    // Dev mode: just the local node
    return [localNodeId];
  }

  /**
   * Get orchestrator for a specific agent (find the parent orchestrator).
   */
  getParentOrchestrator(agentId: string): AgentIdentity | null {
    const agent = this.db.getAgent(agentId);
    if (!agent || !agent.parentId) return null;
    return this.db.getAgent(agent.parentId);
  }
}
