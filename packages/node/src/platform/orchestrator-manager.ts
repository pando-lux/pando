/**
 * OrchestratorProcessManager — Manages orchestrator child processes.
 *
 * Runs on the main Node.js process. Each system orchestrator (council, observer,
 * qa-user) gets its own child process via fork(). The main process stays
 * responsive for API, P2P, and networking.
 *
 * Responsibilities:
 *   - Fork orchestrator-process.js for each orchestrator
 *   - Handle IPC action requests (spawn_worker, commit_code, etc.)
 *   - Monitor child health and restart on crash
 *   - Graceful shutdown on node stop
 *   - Periodic peer count broadcast to children
 */

import { fork, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerPool } from '../core/worker-pool.js';
import type { MessageBus } from '../core/message-bus.js';
import type { OrgManager } from './org-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorManagerDeps {
  workerPool: WorkerPool;
  messageBus: MessageBus;
  orgManager: OrgManager;
  /** Council commit callback (git add, commit, build, push) */
  onCommit?: (message: string) => Promise<boolean>;
  /** Council propose callback (governance proposal) */
  onPropose?: (title: string, description: string) => Promise<void>;
  /** Push SSE event to connected clients */
  pushEvent?: (event: string, data: any) => void;
  /** Send chat result via P2P */
  sendChatResult?: (peerId: string, threadId: string, message: string) => Promise<void>;
  /** Thread store for writing messages */
  threadStore?: { addMessage: (threadId: string, message: any) => Promise<void> };
  /** Get connected peer count */
  getPeerCount?: () => number;
  /** API port */
  apiPort: number;
  /** Data directory */
  dataDir: string;
  /** Repo root */
  repoDir: string;
  /** Graph.json path */
  graphPath?: string;
  /** API token for scenario runner */
  apiToken?: string;
  /** Start an orchestrator (used by create_team IPC action) */
  startOrchestrator?: (orchId: string, isCouncil: boolean) => Promise<void>;
}

interface ManagedProcess {
  child: ChildProcess;
  orchestratorId: string;
  isCouncil: boolean;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// OrchestratorProcessManager
// ---------------------------------------------------------------------------

export class OrchestratorProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private restartCounts = new Map<string, number>();
  private deps: OrchestratorManagerDeps;
  private peerCountTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: OrchestratorManagerDeps) {
    this.deps = deps;

    // Broadcast peer count to all children every 30 seconds
    this.peerCountTimer = setInterval(() => {
      const count = this.deps.getPeerCount?.() ?? 0;
      for (const mp of this.processes.values()) {
        try { mp.child.send({ type: 'peer_count', count }); } catch { /* child may have died */ }
      }
    }, 30_000);
  }

  /**
   * Start an orchestrator in its own child process.
   */
  startOrchestrator(orchestratorId: string, isCouncil = false): void {
    if (this.processes.has(orchestratorId)) {
      console.warn(`[orch-manager] ${orchestratorId} already running`);
      return;
    }

    const modulePath = join(__dirname, 'orchestrator-process.js');
    const childEnv = { ...process.env };
    delete childEnv.PANDO_STORAGE_URL;
    const child = fork(modulePath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: childEnv,
      windowsHide: true,
    } as any);

    const managed: ManagedProcess = {
      child,
      orchestratorId,
      isCouncil,
      startedAt: Date.now(),
    };

    this.processes.set(orchestratorId, managed);

    // Handle IPC messages from child
    child.on('message', (msg: any) => this.handleChildMessage(orchestratorId, msg));

    // Handle child exit
    child.on('exit', (code, signal) => {
      console.log(`[orch-manager] ${orchestratorId} exited (code=${code}, signal=${signal})`);
      this.processes.delete(orchestratorId);

      if (code === 75 && managed.isCouncil) {
        // Safe restart requested by council — propagate to main process
        console.log(`[orch-manager] ${orchestratorId} (council) requested safe restart (code 75)`);
        process.exit(75);
        return;
      }

      const count = this.restartCounts.get(orchestratorId) ?? 0;
      if (!this.stopped && count < 5) {
        // Auto-restart crashed orchestrator after delay
        const delay = Math.min(10_000 * (count + 1), 60_000);
        console.log(`[orch-manager] Restarting ${orchestratorId} in ${delay}ms (attempt ${count + 1})`);
        setTimeout(() => {
          if (!this.stopped) {
            this.restartCounts.set(orchestratorId, count + 1);
            this.startOrchestrator(orchestratorId, isCouncil);
          }
        }, delay);
      }
    });

    // Send start config to child
    child.send({
      type: 'start',
      config: {
        orchestratorId,
        dataDir: this.deps.dataDir,
        apiPort: this.deps.apiPort,
        repoDir: this.deps.repoDir,
        graphPath: this.deps.graphPath,
        isCouncil,
        apiToken: this.deps.apiToken,
      },
    });

    console.log(`[orch-manager] Forked ${orchestratorId} (PID ${child.pid}, council=${isCouncil})`);
  }

  /**
   * Handle IPC messages from a child orchestrator process.
   */
  private async handleChildMessage(orchestratorId: string, msg: any): Promise<void> {
    if (msg.type === 'ready') {
      console.log(`[orch-manager] ${orchestratorId} ready in PID ${msg.pid}`);
      this.restartCounts.delete(orchestratorId);
      return;
    }

    if (msg.type === 'error') {
      console.error(`[orch-manager] ${orchestratorId} error: ${msg.message}`);
      return;
    }

    // Fire-and-forget actions (no response needed)
    if (msg.type === 'fire') {
      this.executeFireAndForget(msg.action, msg.data);
      return;
    }

    // Request/response actions
    if (msg.type === 'action') {
      const { requestId, action, data } = msg;
      try {
        const result = await this.executeAction(orchestratorId, action, data);
        const mp = this.processes.get(orchestratorId);
        if (mp) {
          mp.child.send({ type: 'result', requestId, success: true, data: result });
        }
      } catch (err: any) {
        const mp = this.processes.get(orchestratorId);
        if (mp) {
          mp.child.send({ type: 'result', requestId, success: false, error: err.message });
        }
      }
    }
  }

  /**
   * Execute an action request from a child orchestrator.
   * These actions need main-process resources (worker management, git, P2P, etc.)
   */
  private async executeAction(orchestratorId: string, action: string, data: any): Promise<any> {
    switch (action) {
      case 'spawn_worker': {
        const workerId = await this.deps.workerPool.spawn({
          role: data.role,
          orchestratorId,
          projectId: data.projectId,
          rolePrompt: data.rolePrompt,
          templateId: data.templateId,
          taskId: data.taskId,
          fileScope: data.fileScope,
        });
        return workerId;
      }

      case 'kill_worker': {
        await this.deps.workerPool.kill(data.workerId);
        return true;
      }

      case 'assign_task': {
        await this.deps.workerPool.assignTask(data.workerId, data.task);
        return true;
      }

      case 'commit_code': {
        if (!this.deps.onCommit) throw new Error('No onCommit callback configured');
        return this.deps.onCommit(data.message);
      }

      case 'propose_upgrade': {
        if (!this.deps.onPropose) throw new Error('No onPropose callback configured');
        await this.deps.onPropose(data.title, data.description);
        return true;
      }

      case 'send_chat_result': {
        if (!this.deps.sendChatResult) throw new Error('No sendChatResult callback');
        await this.deps.sendChatResult(data.peerId, data.threadId, data.message);
        return true;
      }

      case 'create_team': {
        // Start the new orchestrator's tick loop in the main process
        const orchId = data.orchestratorId;
        if (orchId && this.deps.startOrchestrator) {
          await this.deps.startOrchestrator(orchId, false);
        }
        return true;
      }

      default:
        throw new Error(`Unknown IPC action: ${action}`);
    }
  }

  /**
   * Fire-and-forget actions — no response sent back to child.
   */
  private executeFireAndForget(action: string, data: any): void {
    try {
      switch (action) {
        case 'push_event':
          this.deps.pushEvent?.(data.event, data.data);
          break;
        case 'thread_store_add':
          this.deps.threadStore?.addMessage(data.threadId, data.message).catch(() => {});
          break;
      }
    } catch (err: any) {
      console.warn(`[orch-manager] Fire-and-forget ${action} failed:`, err.message);
    }
  }

  /**
   * Stop all orchestrator processes gracefully.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.peerCountTimer) {
      clearInterval(this.peerCountTimer);
      this.peerCountTimer = null;
    }

    const promises: Promise<void>[] = [];
    for (const [orchId, mp] of this.processes) {
      promises.push(new Promise((resolve) => {
        console.log(`[orch-manager] Stopping ${orchId} (PID ${mp.child.pid})`);
        mp.child.send({ type: 'stop' });

        // Force kill after 5 seconds
        const timer = setTimeout(() => {
          try { mp.child.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, 5000);

        mp.child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      }));
    }

    await Promise.all(promises);
    this.processes.clear();
    this.restartCounts.clear();
    console.log('[orch-manager] All orchestrator processes stopped');
  }

  /**
   * Check if an orchestrator is running.
   */
  isRunning(orchestratorId: string): boolean {
    return this.processes.has(orchestratorId);
  }

  /**
   * Get PIDs of all running orchestrator processes.
   */
  getRunningProcesses(): Array<{ orchestratorId: string; pid: number; uptime: number }> {
    const now = Date.now();
    return Array.from(this.processes.values()).map(mp => ({
      orchestratorId: mp.orchestratorId,
      pid: mp.child.pid ?? 0,
      uptime: Math.floor((now - mp.startedAt) / 1000),
    }));
  }
}
