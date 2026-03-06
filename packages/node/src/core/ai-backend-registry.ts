/**
 * AIBackendRegistry — runtime registry of available AI backends.
 *
 * Detects and manages all registered AI backends.
 * Provides selection logic to find the best available backend
 * for a given task type.
 *
 * Usage:
 *   const registry = new AIBackendRegistry();
 *   registry.register(new PandoCodeBackend());
 *   await registry.detectAll();
 *   const backend = registry.getBest('code-execution');
 */

import type { AIBackend, AITask, AIResult } from './ai-backend.js';

export class AIBackendRegistry {
  private backends: AIBackend[] = [];

  /**
   * Promise that resolves when engine configuration (budget, tools, credentials)
   * is complete. Set by index.ts / orchestrator-process.ts after configurePandoEngine.
   * WorkerPool.spawn() awaits this before first use to prevent race conditions.
   */
  configReady: Promise<void> = Promise.resolve();

  register(backend: AIBackend): void {
    this.backends.push(backend);
  }

  async detectAll(): Promise<void> {
    await Promise.all(this.backends.map(async b => {
      b.available = await b.detect();
    }));
  }

  getBest(taskType: string): AIBackend | null {
    return this.backends.find(b => b.available && b.capabilities.includes(taskType)) ?? null;
  }

  getAll(): AIBackend[] { return [...this.backends]; }
  getAvailable(): AIBackend[] { return this.backends.filter(b => b.available); }
}
