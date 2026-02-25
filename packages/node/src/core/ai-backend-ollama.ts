/**
 * OllamaBackend — Ollama AI backend stub.
 *
 * Phase v2.1: Implements the AIBackend interface for Ollama.
 * Backend is detected by checking if localhost:11434 responds.
 * Execution is not yet implemented — returns a clear error message.
 *
 * Future: Implement execute() with HTTP calls to Ollama API.
 */

import type { AIBackend, AITask, AIResult } from './ai-backend.js';

export class OllamaBackend implements AIBackend {
  readonly name = 'ollama';
  readonly capabilities = ['text-generation'];
  available = false;

  async detect(): Promise<boolean> {
    try {
      const resp = await fetch('http://localhost:11434/api/tags');
      return resp.ok;
    } catch { return false; }
  }

  async execute(_task: AITask): Promise<AIResult> {
    return {
      success: false,
      output: '',
      backend: this.name,
      error: 'Ollama integration not yet implemented. Backend detected but execution not built.',
    };
  }
}
