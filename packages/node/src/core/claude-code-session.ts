/**
 * ClaudeCodeSession — manages a persistent Claude Code CLI subprocess.
 *
 * When the user selects "claude-code" as their model, this class handles
 * all LLM interaction via the Claude Code CLI instead of PandoCode's API providers.
 *
 * Key features:
 * - Bidirectional streaming (--input-format stream-json + --output-format stream-json)
 * - Persistent sessions (--session-id for resume across restarts)
 * - MCP integration (pando_* tools available to Claude Code)
 * - Event parsing (stream-json → EngineEvent compatible objects)
 * - Token counting from streamed text (for Lux cost calculation)
 * - Reflection reminders (injected after response completes)
 * - Idle timeout management
 */

import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface ClaudeCodeSessionConfig {
  sessionId: string;           // stable ID for resume
  workingDirectory: string;    // project workspace
  systemPrompt?: string;       // identity + rules
  appendSystemPrompt?: string; // memories, goals, inbox
  mcpConfigPath?: string;      // path to MCP config JSON
  apiPort?: number;            // node API port (for generating MCP config)
  apiToken?: string;           // node API token
  idleTimeoutMs?: number;      // close after idle (default: 30 min)
}

export interface ClaudeCodeEvent {
  type: 'stream:chunk' | 'tool:start' | 'tool:result' | 'session:complete' | 'error';
  content?: string;
  toolName?: string;
  args?: unknown;
  result?: { success: boolean; output: string };
  cost?: { inputTokens: number; outputTokens: number; totalCostUsd: number };
  error?: string;
}

export class ClaudeCodeSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private config: ClaudeCodeSessionConfig;
  private buffer: string = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private _isProcessing = false;
  private mcpConfigPath: string | null = null;

  constructor(config: ClaudeCodeSessionConfig) {
    super();
    this.config = config;
  }

  /** Whether the subprocess is alive */
  get alive(): boolean { return this.proc !== null && this.proc.exitCode === null; }

  /** Whether currently processing a response */
  get isProcessing(): boolean { return this._isProcessing; }

  /** Current token counts (for Lux calculation) */
  get tokens(): { input: number; output: number } {
    return { input: this.inputTokens, output: this.outputTokens };
  }

  /**
   * Start the Claude Code subprocess.
   * Creates MCP config, builds CLI args, spawns the process.
   */
  async start(): Promise<void> {
    // 1. Generate MCP config file if apiPort provided
    this.mcpConfigPath = this.config.mcpConfigPath || null;
    if (!this.mcpConfigPath && this.config.apiPort) {
      this.mcpConfigPath = this.generateMcpConfig();
    }

    // 2. Build CLI args
    const args = this.buildArgs();

    // 3. Spawn subprocess with CLAUDECODE env var removed (prevents nested session error)
    const env = { ...process.env };
    delete env.CLAUDECODE;

    this.proc = spawn('claude', args, {
      cwd: this.config.workingDirectory,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // 4. Handle stdout (stream-json events)
    this.proc.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // 5. Handle stderr (debug/error output)
    this.proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`[claude-code:${this.config.sessionId}] ${text}`);
    });

    // 6. Handle process exit
    this.proc.on('exit', (code) => {
      console.log(`[claude-code:${this.config.sessionId}] Process exited with code ${code}`);
      this.proc = null;
      this._isProcessing = false;
      this.emit('exit', code);
    });

    // 7. Start idle timer
    this.resetIdleTimer();
  }

  /**
   * Send a message to the Claude Code subprocess.
   * Returns an async generator of events (compatible with EngineAdapter's event format).
   */
  async *send(message: string): AsyncGenerator<ClaudeCodeEvent> {
    if (!this.alive) {
      await this.start();
    }

    this._isProcessing = true;
    this.resetIdleTimer();

    // Estimate input tokens (rough: 1 token ~ 4 chars)
    this.inputTokens += Math.ceil(message.length / 4);

    // For stream-json input format, we need to send a properly formatted JSON message
    // When using --input-format stream-json, messages are JSON objects on stdin
    const inputMsg = JSON.stringify({
      type: 'user',
      content: message,
    }) + '\n';

    this.proc!.stdin!.write(inputMsg);

    // Collect events until response is complete
    // We use a promise-based approach to yield events as they arrive
    const events: ClaudeCodeEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    const onEvent = (event: ClaudeCodeEvent) => {
      events.push(event);
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };

    const onComplete = () => {
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };

    this.on('event', onEvent);
    this.on('response-complete', onComplete);

    try {
      while (!done) {
        if (events.length > 0) {
          yield events.shift()!;
        } else {
          await new Promise<void>((resolve) => { resolveWait = resolve; });
        }
      }
      // Drain remaining events
      while (events.length > 0) {
        yield events.shift()!;
      }
    } finally {
      this.removeListener('event', onEvent);
      this.removeListener('response-complete', onComplete);
      this._isProcessing = false;
      this.resetIdleTimer();
    }
  }

  /**
   * Send a reflection reminder after a response completes.
   */
  async *sendReflection(): AsyncGenerator<ClaudeCodeEvent> {
    const reflectionPrompt = `Your previous task is complete. Reflect briefly:
- What did you learn? Call pando_save_memory if there's a useful lesson.
- Update board task status if needed. Call pando_board_update.
- Any issues for the team? Call pando_send_message.
If nothing to reflect on, just say "No reflections." and stop.`;

    yield* this.send(reflectionPrompt);
  }

  /** Gracefully close the subprocess */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.proc) {
      this.proc.stdin!.end();
      // Give it 5 seconds to close gracefully
      await Promise.race([
        new Promise<void>((resolve) => this.proc!.on('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill('SIGTERM');
      }
      this.proc = null;
    }
  }

  // ─── Private methods ────────────────────────────────────────────

  private buildArgs(): string[] {
    const args: string[] = [
      '-p',                                    // non-interactive print mode
      '--output-format', 'stream-json',        // streaming JSON events on stdout
      '--input-format', 'stream-json',         // accept streaming JSON on stdin
      '--dangerously-skip-permissions',        // full autonomy
      '--session-id', this.config.sessionId,   // persistent session
      '--include-partial-messages',            // streaming chunks as they arrive
    ];

    if (this.config.systemPrompt) {
      args.push('--system-prompt', this.config.systemPrompt);
    }

    if (this.config.appendSystemPrompt) {
      args.push('--append-system-prompt', this.config.appendSystemPrompt);
    }

    if (this.mcpConfigPath) {
      args.push('--mcp-config', this.mcpConfigPath);
    }

    // Add working directory access
    args.push('--add-dir', this.config.workingDirectory);

    return args;
  }

  /**
   * Generate MCP config file that points to our pando MCP server.
   * Returns path to the generated JSON file.
   */
  private generateMcpConfig(): string {
    const configDir = join(homedir(), '.pando', 'mcp');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, `session-${this.config.sessionId}.json`);

    // Find the MCP server dist path
    // It's at packages/mcp-server/dist/index.js relative to the node package
    const mcpServerPath = join(process.cwd(), 'packages', 'mcp-server', 'dist', 'index.js');

    const config = {
      mcpServers: {
        pando: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            PANDO_NODE_URL: `http://127.0.0.1:${this.config.apiPort || 4000}`,
            ...(this.config.apiToken ? { PANDO_API_TOKEN: this.config.apiToken } : {}),
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  /**
   * Process the stdout buffer, parsing complete JSON lines.
   * Claude Code's stream-json format emits one JSON object per line.
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        this.handleStreamEvent(event);
      } catch {
        // Not valid JSON — could be debug output, ignore
      }
    }
  }

  /**
   * Handle a parsed stream-json event from Claude Code.
   * Converts to ClaudeCodeEvent and emits.
   *
   * Claude Code stream-json format:
   * - { type: "system", subtype: "init", session_id, tools }
   * - { type: "assistant", message: { role, content: [{ type: "text"|"tool_use"|"tool_result", ... }] } }
   * - { type: "result", subtype: "success"|"error", cost_usd, duration_ms, session_id, num_turns }
   */
  private handleStreamEvent(event: any): void {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          // Count output tokens (rough estimate: 1 token ~ 4 chars)
          this.outputTokens += Math.ceil(block.text.length / 4);
          this.emit('event', {
            type: 'stream:chunk',
            content: block.text,
          } as ClaudeCodeEvent);
        }

        if (block.type === 'tool_use') {
          this.emit('event', {
            type: 'tool:start',
            toolName: block.name,
            args: block.input,
          } as ClaudeCodeEvent);
        }

        if (block.type === 'tool_result') {
          const output = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          this.emit('event', {
            type: 'tool:result',
            toolName: block.tool_use_id || 'unknown',
            result: { success: !block.is_error, output },
          } as ClaudeCodeEvent);
        }
      }
    }

    if (event.type === 'result') {
      this.emit('event', {
        type: 'session:complete',
        cost: {
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          totalCostUsd: event.cost_usd || 0,
        },
      } as ClaudeCodeEvent);
      this.emit('response-complete');
    }
  }

  /**
   * Reset the idle timer. After timeout, close the subprocess.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeoutMs = this.config.idleTimeoutMs || 30 * 60 * 1000; // 30 min default
    this.idleTimer = setTimeout(() => {
      console.log(`[claude-code:${this.config.sessionId}] Idle timeout — closing session.`);
      this.close();
    }, timeoutMs);
  }
}
