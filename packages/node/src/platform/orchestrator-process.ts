/**
 * orchestrator-process.ts — Isolated child process for running a single orchestrator.
 *
 * Each system orchestrator (council, observer, qa-user) runs in its own Node.js
 * child process. This guarantees that long AI calls, execSync operations, and
 * heavy computation never block the main event loop (API, P2P, networking).
 *
 * The process creates its own AgentDatabase, MessageBus, and AIBackendRegistry
 * (all backed by the same WAL-mode SQLite file). Actions that need main-process
 * resources (spawn_worker, commit_code, push_event, etc.) go through IPC.
 *
 * Lifecycle:
 *   1. Parent forks this file via child_process.fork()
 *   2. Parent sends { type: 'start', ... } with config
 *   3. This process creates deps, instantiates Orchestrator, calls start()
 *   4. Tick loop runs on this process's event loop — never blocks parent
 *   5. Parent sends { type: 'stop' } for graceful shutdown
 *   6. process.exit(75) from checkSafeRestart → parent detects and restarts node
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { AgentDatabase } from './agent-database.js';
import { Orchestrator } from './orchestrator.js';
import type { OrchestratorDeps } from './orchestrator.js';
import { MessageBus } from '../core/message-bus.js';
import { AIBackendRegistry } from '../core/ai-backend-registry.js';
import { PandoCodeBackend } from '../core/ai-backend-pandocode.js';
import { OrgManager } from './org-manager.js';
import { GenomeBridge, GenomeBridgeRegistry } from './genome-bridge.js';
import { ScenarioRunner } from './scenario-runner.js';
import { TemplateRegistry } from './template-registry.js';

// ---------------------------------------------------------------------------
// IPC Bridge — communication with parent process
// ---------------------------------------------------------------------------

class IPCBridge {
  private pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  /** Peer count, updated periodically by parent */
  peerCount = 0;

  constructor() {
    process.on('message', (msg: any) => {
      if (msg.type === 'result') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          if (msg.success) p.resolve(msg.data);
          else p.reject(new Error(msg.error || 'IPC action failed'));
        }
      } else if (msg.type === 'peer_count') {
        this.peerCount = msg.count ?? 0;
      }
    });
  }

  /**
   * Send an action request to the parent and await the result.
   * Used for operations that require main-process resources.
   */
  async request(action: string, data: any): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      // Timeout after 5 minutes (long builds can take a while)
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`IPC timeout for action: ${action}`));
      }, 300_000);
      // Clear timeout on resolution
      const origResolve = resolve;
      const origReject = reject;
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });
      process.send!({ type: 'action', requestId, action, data });
    });
  }

  /** Fire-and-forget: send to parent without waiting for response */
  fire(action: string, data: any): void {
    process.send!({ type: 'fire', action, data });
  }
}

// ---------------------------------------------------------------------------
// Minimal WorkerPool proxy — satisfies the interface via IPC
// ---------------------------------------------------------------------------

function createWorkerPoolProxy(bridge: IPCBridge, db: AgentDatabase): any {
  return {
    async spawn(opts: any): Promise<string> {
      return bridge.request('spawn_worker', opts);
    },
    async kill(workerId: string): Promise<void> {
      await bridge.request('kill_worker', { workerId });
    },
    getActiveProcesses(): Map<string, any> {
      // Intentionally empty: worker processes are tracked by the parent (main) process.
      // The child orchestrator only proxies spawn/kill via IPC. SelfRestartProtocol
      // watchdog runs on the main process where the real WorkerPool lives.
      return new Map();
    },
  };
}

// ---------------------------------------------------------------------------
// Main: wait for start message, then create and run orchestrator
// ---------------------------------------------------------------------------

let orchestrator: Orchestrator | null = null;

interface StartConfig {
  orchestratorId: string;
  dataDir: string;
  apiPort: number;
  repoDir: string;
  graphPath?: string;
  isCouncil: boolean;
  apiToken?: string;
}

process.on('message', async (msg: any) => {
  if (msg.type === 'stop') {
    console.log(`[orch-process:${process.pid}] Received stop signal`);
    orchestrator?.stop();
    // Give orchestrator a moment to finish current tick
    setTimeout(() => process.exit(0), 2000);
    return;
  }

  if (msg.type !== 'start') return;

  const config: StartConfig = msg.config;
  const { orchestratorId } = config;

  try {
    // Create own database connection (WAL mode supports concurrent access)
    const db = new AgentDatabase(config.dataDir);
    const messageBus = new MessageBus(db);

    // Create own AI backend registry — PandoCode is the only backend
    const aiRegistry = new AIBackendRegistry();
    aiRegistry.register(new PandoCodeBackend());
    await aiRegistry.detectAll();

    // Template registry shares the same db
    const templateRegistry = new TemplateRegistry(db.getRawDb());

    // IPC bridge for actions needing main process
    const bridge = new IPCBridge();

    // WorkerPool proxy (spawn/kill via IPC)
    const workerPoolProxy = createWorkerPoolProxy(bridge, db);

    // OrgManager with own db + proxy workerPool
    const orgManager = new OrgManager(db, workerPoolProxy, messageBus);

    // Genome bridge (reads graph.json file — self-contained)
    let genomeBridge: GenomeBridge | undefined;
    let genomeBridgeRegistry: GenomeBridgeRegistry | undefined;
    if (config.graphPath && existsSync(config.graphPath)) {
      try {
        genomeBridge = new GenomeBridge(config.graphPath);
        genomeBridgeRegistry = new GenomeBridgeRegistry(config.graphPath);
      } catch { /* graph not available */ }
    }

    // Scenario runner (HTTP calls to local API — self-contained)
    let scenarioRunner: ScenarioRunner | undefined;
    if (config.apiToken) {
      try {
        scenarioRunner = new ScenarioRunner({
          graphPath: config.graphPath || join(config.repoDir, 'output', 'graph.json'),
          apiBaseUrl: `http://127.0.0.1:${config.apiPort}`,
          apiToken: config.apiToken,
        });
      } catch { /* scenario runner not available */ }
    }

    // Build dependencies — mix of real (self-contained) and IPC-proxied
    const deps: OrchestratorDeps = {
      db,
      messageBus,
      workerPool: workerPoolProxy,
      orgManager,
      aiRegistry,
      templateRegistry,
      genomeBridge,
      genomeBridgeRegistry,
      scenarioRunner,
      apiPort: config.apiPort,
      dataDir: config.dataDir,
      repoDir: config.repoDir,

      // IPC-proxied callbacks
      onCommit: config.isCouncil ? async (message: string): Promise<boolean> => {
        return bridge.request('commit_code', { message });
      } : undefined,

      onPropose: config.isCouncil ? async (title: string, description: string): Promise<void> => {
        await bridge.request('propose_upgrade', { title, description });
      } : undefined,

      pushEvent: (event: string, data: any) => {
        bridge.fire('push_event', { event, data });
      },

      sendChatResult: async (peerId: string, threadId: string, message: string) => {
        await bridge.request('send_chat_result', { peerId, threadId, message });
      },

      getPeerCount: () => bridge.peerCount,

      // threadStore is IPC-proxied (only used by respond_to_user)
      threadStore: {
        addMessage: async (threadId: string, message: any) => {
          bridge.fire('thread_store_add', { threadId, message });
        },
      } as any,
    };

    orchestrator = new Orchestrator(orchestratorId, deps);
    orchestrator.start();

    process.send!({ type: 'ready', orchestratorId, pid: process.pid });
    console.log(`[orch-process] Orchestrator ${orchestratorId} running in PID ${process.pid}`);

  } catch (err: any) {
    console.error(`[orch-process] Failed to start ${orchestratorId}:`, err.message);
    process.send!({ type: 'error', orchestratorId, message: err.message });
    process.exit(1);
  }
});

// Handle parent disconnect (parent crashed)
process.on('disconnect', () => {
  console.log(`[orch-process:${process.pid}] Parent disconnected, shutting down`);
  orchestrator?.stop();
  process.exit(0);
});

// Log that child process is ready for start message
console.log(`[orch-process] Child process PID ${process.pid} waiting for start message`);
