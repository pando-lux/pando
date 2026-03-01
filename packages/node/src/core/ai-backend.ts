/**
 * AIBackend — interface for pluggable AI execution backends.
 *
 * Phase v2.1: Abstracts the AI execution layer so the agent system
 * is not hardcoded to Claude Code. Any backend (Claude Code, Ollama,
 * ComfyUI, etc.) can be registered and selected at runtime.
 *
 * Architecture rule: agent.ts must NEVER spawn 'claude' directly.
 * All AI execution goes through AIBackendRegistry.getBest(taskType).
 */

export interface AIBackend {
  readonly name: string;            // 'claude-code', 'ollama', 'comfyui'
  readonly capabilities: string[];  // ['text-generation', 'code-execution']
  available: boolean;

  execute(task: AITask): Promise<AIResult>;
  detect(): Promise<boolean>;
}

export interface AITask {
  type: 'text' | 'code' | 'image';
  prompt: string;
  context?: string;
  sessionId?: string;       // For resume-able sessions (Claude Code)
  options?: Record<string, unknown>;
}

export interface AIResult {
  success: boolean;
  output: string;
  backend: string;
  sessionId?: string;       // Backend may return a session ID for resumption
  cost?: number;
  error?: string;
  exitCode?: number;
}
