/**
 * WorkerPool — Manages Claude Code worker processes.
 *
 * Extracted from agent-manager.ts. Does ONE thing: spawn/kill Claude Code workers.
 * All orchestration logic lives in the Orchestrator class.
 *
 * Responsibilities:
 *   - Create workspace directories
 *   - Assemble worker CLAUDE.md via assembleContext()
 *   - Start Claude Code processes via AIBackendRegistry
 *   - Register workers in agent_identity table
 *   - Kill workers and clean up
 *
 * Does NOT:
 *   - Watch bridge queues or message buses
 *   - Manage orchestrator hierarchy
 *   - Track task lifecycle
 *   - Make scheduling decisions
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { AgentDatabase, AgentIdentity, AgentType, AgentScope } from '../platform/agent-database.js';
import type { AIBackendRegistry } from './ai-backend-registry.js';
import type { AIResult } from './ai-backend.js';
import { MessageBus } from './message-bus.js';
import { generateWorkerToolsDocs } from './worker-mcp.js';
import type { GenomeBridge } from '../platform/genome-bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  role: string;                    // 'builder', 'tester', 'reviewer', etc.
  orchestratorId: string;         // parent orchestrator
  taskId?: string;                // task to assign
  projectId?: string;             // project context
  scope?: AgentScope;             // 'private' | 'public'
  nodeId?: string;
  budgetLimit?: number;
  fileScope?: string[];           // files this worker can touch
  rolePrompt?: string;            // short role description
  authority?: Record<string, unknown>;
  workspaceDir?: string;          // override workspace path
}

export type SessionStrategy = 'fresh' | 'resume' | 'rotate';

export interface WorkerStatus {
  id: string;
  role: string;
  status: string;
  taskId: string | null;
  pid: number | null;
  sessionId: string | null;
  budgetSpent: number;
  budgetLimit: number;
  lastReportAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Default role prompts (short — not 365-line templates)
// ---------------------------------------------------------------------------

const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  builder: `You are a Pando builder agent. Your job is to write code that fulfills the task description.
Read existing code before modifying. Run the build after changes. Report progress via your tools.
When done, call report_progress with status "done" and list all files you changed.`,

  tester: `You are a Pando QA tester agent. Your job is to independently verify that code changes work correctly.
You do NOT trust the builder's claims. Test everything yourself.
Run tests, check edge cases, verify the build passes. Report PASS or FAIL with evidence.
When done, call report_progress with status "done" and your verdict in the summary.`,

  reviewer: `You are a Pando code reviewer. Review the code changes for correctness, security, and style.
Look for bugs, security vulnerabilities, and architectural issues.
Report your findings via report_progress.`,

  researcher: `You are a Pando researcher. Investigate the question or problem described in your task.
Read relevant files, search the codebase, and provide a clear analysis.
Report findings via report_progress.`,

  devops: `You are a Pando devops agent. Handle deployment, infrastructure, and operations tasks.
Be careful with destructive operations. Always verify before modifying production systems.
Report progress via your tools.`,
};

// ---------------------------------------------------------------------------
// WorkerPool class
// ---------------------------------------------------------------------------

export class WorkerPool {
  private dataDir: string;
  private apiPort: number;
  private activeProcesses = new Map<string, { kill: () => void }>();

  private genomeBridge: GenomeBridge | null = null;

  constructor(
    private db: AgentDatabase,
    private aiRegistry: AIBackendRegistry,
    private messageBus: MessageBus,
    opts?: { dataDir?: string; apiPort?: number; genomeBridge?: GenomeBridge },
  ) {
    this.dataDir = opts?.dataDir || join(homedir(), '.pando');
    this.apiPort = opts?.apiPort || 4000;
    this.genomeBridge = opts?.genomeBridge || null;
  }

  /**
   * Spawn or resume a Claude Code worker process.
   * Checks for existing workers with same role + orchestrator that have a session.
   * If found, resumes the existing worker instead of creating a new one.
   */
  async spawn(config: WorkerConfig): Promise<string> {
    // ── Check for existing worker to resume ──────────────────────────────
    let workerId: string;
    let resumeSessionId: string | undefined;
    let workspaceDir: string;
    let agent: AgentIdentity;

    const existing = this.findResumableWorker(config);

    if (existing) {
      // Resume existing worker — preserve session context
      workerId = existing.id;
      resumeSessionId = existing.sessionId || undefined;
      workspaceDir = existing.workspaceDir || join(this.dataDir, 'agents', workerId);

      // Update worker with new task
      this.db.updateAgent(workerId, {
        status: 'spawning',
        currentTaskId: config.taskId || null,
        rolePrompt: config.rolePrompt || existing.rolePrompt || null,
      });
      agent = this.db.getAgent(workerId)!;

      console.log(`[WorkerPool] Resuming ${config.role} worker ${workerId} (session: ${resumeSessionId?.slice(0, 8) || 'none'})`);
    } else {
      // Create fresh worker
      workerId = `worker-${config.role}-${randomUUID().slice(0, 8)}`;
      workspaceDir = config.workspaceDir || join(this.dataDir, 'agents', workerId);
      if (!existsSync(workspaceDir)) {
        mkdirSync(workspaceDir, { recursive: true });
      }

      agent = this.db.createAgent({
        id: workerId,
        role: config.role,
        type: 'worker' as AgentType,
        scope: config.scope || 'private',
        parentId: config.orchestratorId,
        nodeId: config.nodeId || null,
        status: 'spawning',
        authority: config.authority ? JSON.stringify(config.authority) : null,
        fileScope: config.fileScope ? JSON.stringify(config.fileScope) : null,
        budgetLimit: config.budgetLimit ?? 50,
        projectId: config.projectId || null,
        workspaceDir,
        currentTaskId: config.taskId || null,
        rolePrompt: config.rolePrompt || DEFAULT_ROLE_PROMPTS[config.role] || null,
        contextVersion: null,
        sessionId: null,
        pid: null,
        persistent: false,
        tickIntervalMs: null,
        lastTickAt: null,
        maxWorkers: 0,
        maxChildren: 0,
        lastReportAt: null,
      });

      console.log(`[WorkerPool] Creating fresh ${config.role} worker ${workerId}`);
    }

    // Assemble context and write CLAUDE.md
    const claudeMd = this.assembleContext(agent);
    writeFileSync(join(workspaceDir, 'CLAUDE.md'), claudeMd);

    // Get AI backend
    const backend = this.aiRegistry.getBest('code-execution');
    if (!backend) {
      this.db.updateAgent(workerId, { status: 'failed' });
      throw new Error('No AI backend available (Claude Code not found)');
    }

    // Build the task prompt
    // For resumed workers: shorter prompt (they already know the codebase)
    // For fresh workers: full context in prompt
    const projectRoot = process.cwd();
    let taskPrompt: string;

    if (resumeSessionId) {
      // Resumed worker — they already have context. Just give them the new task.
      taskPrompt = `You are continuing your work. Your agent ID is: ${workerId}\n`;
      taskPrompt += `Project root: ${projectRoot}\n`;
      taskPrompt += `Scratch workspace: ${workspaceDir}\n`;
      if (config.taskId) {
        taskPrompt += `New task ID: ${config.taskId}\n`;
      }
      taskPrompt += `\n## New Task\n`;
      taskPrompt += config.rolePrompt || DEFAULT_ROLE_PROMPTS[config.role] || 'Complete the assigned task.';
      taskPrompt += `\n\nWhen you finish, report via HTTP:\n`;
      taskPrompt += `curl -s -X POST http://localhost:${this.apiPort}/v1/worker/${workerId}/report -H "Content-Type: application/json" --data-raw '{"status":"done","summary":"<what you did>","filesChanged":["list","of","files"]}'\n`;
      taskPrompt += `\nIMPORTANT: The build MUST pass (npm run build) before you report "done".\n`;
      taskPrompt += `Start working now.`;
    } else {
      // Fresh worker — full context
      taskPrompt = claudeMd;
      taskPrompt += `\n\n---\n`;
      taskPrompt += `\nYou are starting now. Your agent ID is: ${workerId}`;
      taskPrompt += `\nProject root: ${projectRoot}`;
      taskPrompt += `\nScratch workspace: ${workspaceDir}`;
      if (config.taskId) {
        taskPrompt += `\nTask ID: ${config.taskId}`;
      }
      taskPrompt += `\n\nWhen you finish, report via HTTP:`;
      taskPrompt += `\ncurl -s -X POST http://localhost:${this.apiPort}/v1/worker/${workerId}/report -H "Content-Type: application/json" --data-raw '{"status":"done","summary":"<what you did>","filesChanged":["list","of","files"]}'`;
      taskPrompt += `\n\nIMPORTANT: The build MUST pass (npm run build) before you report "done".`;
      taskPrompt += `\nStart working now.`;
    }

    // Clone backend for per-worker callbacks
    const claudeBackend = backend as any;
    const onProgressOrig = claudeBackend.onProgress;
    const onPidOrig = claudeBackend.onPid;

    claudeBackend.onPid = (pid: number) => {
      this.db.updateAgent(workerId, { pid, status: 'active' });
    };

    // Start Claude Code process — with session resume if available
    const resultPromise = backend.execute({
      type: 'code',
      prompt: taskPrompt,
      sessionId: resumeSessionId,
      options: { cwd: projectRoot },
    });

    // Track the process for killing
    this.activeProcesses.set(workerId, {
      kill: () => {
        const agent = this.db.getAgent(workerId);
        if (agent?.pid) {
          try { process.kill(agent.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      },
    });

    console.log(`[WorkerPool] Spawned ${config.role} worker ${workerId} in ${projectRoot}`);

    // Handle completion asynchronously
    resultPromise.then((result: AIResult) => {
      // Restore original callbacks
      claudeBackend.onProgress = onProgressOrig;
      claudeBackend.onPid = onPidOrig;

      this.activeProcesses.delete(workerId);

      const currentAgent = this.db.getAgent(workerId);
      if (!currentAgent) return;

      // Update session ID for future resume
      if (result.sessionId) {
        this.db.updateAgent(workerId, { sessionId: result.sessionId });
      }

      // Update budget
      if (result.cost) {
        this.db.updateAgent(workerId, { budgetSpent: (currentAgent.budgetSpent || 0) + result.cost });
      }

      console.log(`[WorkerPool] Worker ${workerId} finished — success=${result.success}, cost=$${result.cost?.toFixed(4) || '0'}`);

      // If worker didn't report via HTTP (crashed or timed out), auto-report
      if (currentAgent.status === 'active' || currentAgent.status === 'spawning') {
        const status = result.success ? 'done' : 'failed';
        this.db.updateAgent(workerId, { status });

        // Notify orchestrator
        this.messageBus.send({
          recipientId: config.orchestratorId,
          senderId: workerId,
          senderType: 'worker',
          type: 'worker_report',
          payload: {
            status: result.success ? 'done' : 'failed',
            summary: result.success
              ? `Worker completed. Output: ${result.output?.slice(0, 500) || 'no output'}`
              : (result.error || 'Worker process failed'),
            taskId: config.taskId,
            auto: true,  // auto-generated, not from worker HTTP report
          },
          priority: result.success ? 1 : 0,
        });
        console.log(`[WorkerPool] Auto-reported ${status} for worker ${workerId} to orchestrator`);
      }
    }).catch((err) => {
      claudeBackend.onProgress = onProgressOrig;
      claudeBackend.onPid = onPidOrig;
      this.activeProcesses.delete(workerId);
      this.db.updateAgent(workerId, { status: 'failed' });
      console.error(`[WorkerPool] Worker ${workerId} crashed:`, err.message?.slice(0, 200));
    });

    return workerId;
  }

  /**
   * Kill a worker process.
   */
  kill(workerId: string): void {
    const proc = this.activeProcesses.get(workerId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(workerId);
    }

    const agent = this.db.getAgent(workerId);
    if (agent && !['done', 'failed', 'dissolved'].includes(agent.status)) {
      this.db.updateAgent(workerId, { status: 'failed' });
    }
  }

  /**
   * Get worker status from database.
   */
  getStatus(workerId: string): WorkerStatus | null {
    const agent = this.db.getAgent(workerId);
    if (!agent || agent.type !== 'worker') return null;
    return {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      taskId: agent.currentTaskId,
      pid: agent.pid,
      sessionId: agent.sessionId,
      budgetSpent: agent.budgetSpent,
      budgetLimit: agent.budgetLimit,
      lastReportAt: agent.lastReportAt,
      createdAt: agent.createdAt,
    };
  }

  /**
   * List all active workers.
   */
  listActive(): WorkerStatus[] {
    return this.db.listAgents({ type: 'worker', status: 'active' }).map(a => ({
      id: a.id,
      role: a.role,
      status: a.status,
      taskId: a.currentTaskId,
      pid: a.pid,
      sessionId: a.sessionId,
      budgetSpent: a.budgetSpent,
      budgetLimit: a.budgetLimit,
      lastReportAt: a.lastReportAt,
      createdAt: a.createdAt,
    }));
  }

  /**
   * Clean up orphaned processes and old workspaces.
   */
  cleanup(): void {
    // Find workers that are active but have no running process
    const activeWorkers = this.db.listAgents({ type: 'worker', status: 'active' });
    for (const worker of activeWorkers) {
      if (worker.pid && !this.activeProcesses.has(worker.id)) {
        // Check if process is actually running
        try {
          process.kill(worker.pid, 0);
        } catch {
          // Process is dead, mark as failed
          this.db.updateAgent(worker.id, { status: 'failed' });
        }
      }
    }
  }

  /**
   * Determine session strategy for a worker.
   */
  determineSessionStrategy(workerId: string): SessionStrategy {
    const agent = this.db.getAgent(workerId);
    if (!agent || !agent.sessionId) return 'fresh';

    // If worker has a current task that's in progress → resume
    if (agent.currentTaskId && agent.status === 'active') {
      return 'resume';
    }

    // If worker has a project but different task → rotate (new session, same workspace)
    if (agent.projectId) {
      return 'rotate';
    }

    return 'fresh';
  }

  /**
   * Find an existing worker that can be resumed for this config.
   * Matches by: same role + same orchestrator + has a session + not currently active.
   * Prefers workers with matching projectId. Returns null if no resumable worker found.
   */
  private findResumableWorker(config: WorkerConfig): AgentIdentity | null {
    // Find completed/idle workers under this orchestrator with same role
    const candidates = this.db.listAgents({
      parentId: config.orchestratorId,
      type: 'worker' as AgentType,
      role: config.role,
    }).filter(w =>
      // Must have a session to resume
      w.sessionId &&
      // Must not be currently running
      !this.activeProcesses.has(w.id) &&
      // Must be in a resumable state (done, idle, or failed — not actively spawning/running)
      ['done', 'idle', 'failed'].includes(w.status)
    );

    if (candidates.length === 0) return null;

    // Prefer workers from the same project
    if (config.projectId) {
      const sameProject = candidates.find(w => w.projectId === config.projectId);
      if (sameProject) return sameProject;
    }

    // Otherwise return most recent worker with a session
    return candidates[0]; // listAgents returns DESC by created_at
  }

  /**
   * Assemble the CLAUDE.md content for a worker.
   * Pulls from 5 layers: role, project, task, lessons, authority.
   */
  private assembleContext(agent: AgentIdentity): string {
    const sections: string[] = [];

    // Header
    sections.push(`# You are a Pando ${agent.role}`);
    sections.push(`Agent ID: ${agent.id}`);
    sections.push(`Scope: ${agent.scope}`);
    sections.push(`Reports to: ${agent.parentId || 'none'}`);
    sections.push('');

    // Layer 1: Role prompt
    const rolePrompt = agent.rolePrompt || DEFAULT_ROLE_PROMPTS[agent.role] || 'Complete the assigned task.';
    sections.push('## Your Role');
    sections.push(rolePrompt);
    sections.push('');

    // Layer 2: Authority
    if (agent.authority) {
      try {
        const auth = JSON.parse(agent.authority);
        sections.push('## Authority');
        if (auth.files?.write) sections.push(`Files you can write: ${JSON.stringify(auth.files.write)}`);
        if (auth.files?.forbidden) sections.push(`Files you MUST NOT touch: ${JSON.stringify(auth.files.forbidden)}`);
        if (auth.commands?.forbidden) sections.push(`Commands you MUST NOT run: ${JSON.stringify(auth.commands.forbidden)}`);
        sections.push('');
      } catch { /* skip */ }
    }

    // Layer 3: Lessons from previous work
    const lessons = this.db.getLessons({
      orchestratorId: agent.parentId || undefined,
      projectId: agent.projectId || undefined,
      role: agent.role,
      minConfidence: 0.5,
      limit: 10,
    });
    const orgKnowledge = this.db.getOrgKnowledge({ role: agent.role, limit: 5 });

    if (lessons.length > 0 || orgKnowledge.length > 0) {
      sections.push('## Lessons from Previous Work');
      for (const l of lessons) {
        sections.push(`- ${l.lesson}`);
        this.db.incrementLessonUse(l.id);
      }
      for (const k of orgKnowledge) {
        sections.push(`- [org] ${k.knowledge}`);
      }
      sections.push('');
    }

    // Layer 4: Directives
    const directives = this.db.getDirectives(agent.id);
    if (directives.length > 0) {
      sections.push('## Directives');
      for (const d of directives) {
        sections.push(`- ${d.content}`);
      }
      sections.push('');
    }

    // Layer 5: Worker tools documentation
    sections.push(generateWorkerToolsDocs(agent.id, this.apiPort));
    sections.push('');

    // Layer 6: Genome architecture context
    if (this.genomeBridge?.isLoaded()) {
      const ctx = this.genomeBridge.contextForTask({
        taskDescription: agent.rolePrompt || '',
        role: agent.role,
        fileScope: agent.fileScope ? JSON.parse(agent.fileScope) : undefined,
      });
      if (ctx) {
        sections.push('## Architecture Context (from Genome)');
        sections.push(ctx);
        sections.push('');
      }
    }

    // Build rules
    sections.push('## Build & Test');
    sections.push('After making changes, run: `npm run build`');
    sections.push('The build MUST pass before you report "done".');
    sections.push('');

    return sections.join('\n');
  }
}
