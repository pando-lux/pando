/**
 * PandoCodeBackend — AI backend powered by @pando-code/core engine.
 *
 * The sole AI backend for Pando. Implements the AIBackend interface so the
 * orchestrator and worker-pool work via AIBackendRegistry.
 *
 *   - Runs in-process (no subprocess spawn)
 *   - Uses PandoCode's built-in tool system (file ops, edit, bash, search, etc.)
 *   - Supports BudgetProvider injection (Lux via @pando/node)
 *   - Supports custom tool registration (deploy, governance, ledger, etc.)
 *   - Session persistence via PandoCode's SQLite DB
 */

import type { AIBackend, AITask, AIResult } from './ai-backend.js';

// Dynamic import to avoid module resolution issues at compile time.
// @pando-code/core is an ESM package consumed from NodeNext.
let _PandoCode: any = null;
let _loadPromise: Promise<void> | null = null;

async function loadPandoCode(): Promise<void> {
  if (_PandoCode) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const mod = await import('@pando-code/core');
    _PandoCode = mod.PandoCode;
  })();
  return _loadPromise;
}

export class PandoCodeBackend implements AIBackend {
  readonly name = 'pando-code';
  readonly capabilities = ['text-generation', 'code-execution'];
  available = false;

  /** Called with progress text during execution. */
  onProgress?: (msg: string) => void;
  /** Called with a fake "pid" (engine instance hash) after engine starts. */
  onPid?: (pid: number) => void;

  /** Shared engine instances keyed by project path. */
  private engines = new Map<string, any>();
  /** Last access time per engine key, for TTL eviction. */
  private engineLastUsed = new Map<string, number>();
  /** Engine TTL: evict after 30 minutes of inactivity. */
  private static ENGINE_TTL_MS = 30 * 60 * 1000;
  /** Pending budget provider for future engines. */
  private pendingBudgetProvider: { currency: string; calculateCost: (usage: any) => number } | null = null;
  /** Pending custom tools for future engines. */
  private pendingTools: Array<{ name: string; description: string; parameters: any; execute: (args: any) => Promise<any> }> = [];

  async detect(): Promise<boolean> {
    try {
      await loadPandoCode();
      this.available = _PandoCode !== null;
      return this.available;
    } catch (err) {
      console.warn('[PandoCodeBackend] Failed to load @pando-code/core:', (err as Error).message);
      this.available = false;
      return false;
    }
  }

  /**
   * Get or create a PandoCode engine for a project path.
   * Engines are reused across calls to the same project for session persistence.
   */
  private async getEngine(projectPath: string, model?: string): Promise<any> {
    const key = projectPath;
    if (this.engines.has(key)) {
      this.engineLastUsed.set(key, Date.now());
      return this.engines.get(key);
    }

    // Evict stale engines before creating a new one
    this.evictStaleEngines();

    await loadPandoCode();
    const engine = await _PandoCode.create({
      projectPath,
      model: model || 'claude-opus-4-6',
      role: 'builder',
      maxSteps: 200,
      skipKnowledgeSync: true, // Skip API-dependent background sync
    });

    this.engines.set(key, engine);
    this.engineLastUsed.set(key, Date.now());
    return engine;
  }

  /** Evict engines that haven't been used within the TTL window. */
  private evictStaleEngines(): void {
    const now = Date.now();
    for (const [key, lastUsed] of this.engineLastUsed) {
      if (now - lastUsed > PandoCodeBackend.ENGINE_TTL_MS) {
        const engine = this.engines.get(key);
        if (engine) {
          engine.shutdown().catch(() => {});
          this.engines.delete(key);
          this.engineLastUsed.delete(key);
          console.log(`[PandoCodeBackend] Evicted stale engine for ${key} (idle ${Math.round((now - lastUsed) / 60000)}min)`);
        }
      }
    }
  }

  /**
   * Register a BudgetProvider on all engines (called by engine-bridge).
   */
  setBudgetProvider(provider: { currency: string; calculateCost: (usage: any) => number }): void {
    for (const engine of this.engines.values()) {
      engine.setBudgetProvider(provider);
    }
    this.pendingBudgetProvider = provider;
  }

  /**
   * Register a custom tool on all engines (called by engine-bridge).
   */
  registerCustomTool(tool: { name: string; description: string; parameters: any; execute: (args: any) => Promise<any> }): void {
    for (const engine of this.engines.values()) {
      engine.tools.register(tool);
    }
    this.pendingTools.push(tool);
  }

  async execute(task: AITask): Promise<AIResult> {
    if (!this.available) {
      return { success: false, output: '', backend: this.name, error: 'PandoCode engine not available' };
    }

    const model = (task.options?.model as string) || 'claude-opus-4-6';
    const projectPath = (task.options?.cwd as string) || process.cwd();

    try {
      const engine = await this.getEngine(projectPath, model);

      // Apply pending budget provider if set
      if (this.pendingBudgetProvider) {
        engine.setBudgetProvider(this.pendingBudgetProvider);
      }

      // Apply pending custom tools
      for (const tool of this.pendingTools) {
        if (!engine.tools.has(tool.name)) {
          engine.tools.register(tool);
        }
      }

      // Generate a fake PID for tracking (hash of engine + timestamp)
      const fakePid = Math.floor(Math.random() * 100000) + 50000;
      this.onPid?.(fakePid);
      this.onProgress?.('PandoCode engine initialized');

      // Start a session if needed
      if (!engine.getSessionId()) {
        await engine.startSession('Worker task');
      }

      // Collect output from the async generator
      const outputParts: string[] = [];
      let totalCost = 0;
      const sessionId = engine.getSessionId();

      for await (const event of engine.send(task.prompt)) {
        switch (event.type) {
          case 'stream:chunk':
            if (event.content) {
              outputParts.push(event.content);
              // Forward progress
              const firstLine = event.content.split('\n')[0];
              if (firstLine.length > 10) {
                this.onProgress?.(firstLine.slice(0, 200));
              }
            }
            break;

          case 'tool:start':
            this.onProgress?.(`Tool: ${event.toolName}`);
            break;

          case 'tool:result':
            if (event.result && !event.result.success) {
              this.onProgress?.(`Tool ${event.toolName} failed`);
            }
            break;

          case 'session:complete':
            if (event.result) {
              totalCost = event.result.costUSD || 0;
            }
            this.onProgress?.('Completed');
            break;

          case 'budget:warning':
            this.onProgress?.(`Budget warning: ${event.state.percentUsed.toFixed(0)}% used`);
            break;

          case 'error:doom_loop':
            this.onProgress?.(`Doom loop detected: ${event.pattern}`);
            break;
        }
      }

      // Get budget info
      const budget = engine.getBudget();
      if (budget.cost > totalCost) totalCost = budget.cost;

      const output = outputParts.join('\n');

      return {
        success: true,
        output: output || 'Task completed (no text output)',
        backend: this.name,
        sessionId: sessionId || undefined,
        cost: totalCost > 0 ? totalCost : undefined,
      };

    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[PandoCodeBackend] Execution error:`, errorMsg);
      return {
        success: false,
        output: '',
        backend: this.name,
        error: errorMsg,
      };
    }
  }

  /**
   * Shut down all engines cleanly.
   */
  async shutdown(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.shutdown();
      } catch { /* best effort */ }
    }
    this.engines.clear();
    this.engineLastUsed.clear();
  }
}
