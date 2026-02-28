/**
 * ClaudeBackend — Claude Code AI backend implementation.
 *
 * Phase v2.1: Extracts the Claude Code spawn lifecycle from agent.ts.
 * Implements the AIBackend interface so agents are not hardcoded to Claude Code.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import type { AIBackend, AITask, AIResult } from './ai-backend.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HARD_CAP_MS = 2 * 60 * 60 * 1000;

function buildAugmentedPath(): string {
  const extra = platform() === 'win32'
    ? []
    : [
        `${process.env.HOME || homedir()}/.local/bin`,
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ];
  const current = process.env.PATH || '';
  return extra.length > 0 ? `${extra.join(':')}:${current}` : current;
}

const AUGMENTED_PATH = buildAugmentedPath();

export function detectClaudePath(): string | null {
  try {
    if (platform() === 'win32') {
      return execSync('where claude', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        .trim().split('\n')[0].trim();
    }
    return execSync('which claude', {
      encoding: 'utf-8',
      env: { ...process.env, PATH: AUGMENTED_PATH },
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    const home = process.env.HOME || homedir();
    const candidates = [
      `${home}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }
}

export class ClaudeBackend implements AIBackend {
  readonly name = 'claude-code';
  readonly capabilities = ['text-generation', 'code-execution'];
  available = false;
  onProgress?: (msg: string) => void;
  /** Called immediately after spawn with the child process PID. */
  onPid?: (pid: number) => void;

  async detect(): Promise<boolean> {
    return detectClaudePath() !== null;
  }

  async execute(task: AITask): Promise<AIResult> {
    const claudePath = detectClaudePath();
    if (!claudePath) {
      return { success: false, output: '', backend: this.name, error: 'Claude CLI not found.' };
    }

    const model = (task.options?.model as string) || 'claude-opus-4-6';
    const workingDir = task.options?.cwd as string | undefined;

    const noTools = task.options?.noTools === true;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
    ];
    // Only grant full tool access for workers (code execution).
    // Orchestrator brain calls use noTools=true — no file access, no tool use.
    if (!noTools) {
      args.push('--dangerously-skip-permissions');
    }

    if (task.sessionId) {
      args.unshift('--resume', task.sessionId);
    }

    // End-of-options separator + positional prompt argument.
    // Must come last so prompts starting with dashes aren't parsed as flags.
    args.push('--', task.prompt);

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.PATH = AUGMENTED_PATH;
    delete env.CLAUDECODE;
    delete env.CREDENTIAL_MASTER_KEY;
    delete env.PANDO_STORAGE_URL;

    return new Promise<AIResult>((resolve) => {
      const child = spawn(claudePath, args, {
        cwd: workingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      if (child.pid) this.onPid?.(child.pid);

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lineBuffer = '';

      let idleTimer = setTimeout(() => {
        child.kill();
        resolve({ success: false, output: '', backend: this.name, error: `Idle timeout after ${IDLE_TIMEOUT_MS / 60000} min` });
      }, IDLE_TIMEOUT_MS);

      const hardCapTimer = setTimeout(() => {
        child.kill();
        resolve({ success: false, output: '', backend: this.name, error: `Hard cap after ${HARD_CAP_MS / 3600000}h` });
      }, HARD_CAP_MS);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          child.kill();
          resolve({ success: false, output: '', backend: this.name, error: `Idle timeout after ${IDLE_TIMEOUT_MS / 60000} min` });
        }, IDLE_TIMEOUT_MS);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuffer += text;
        resetIdle();
        if (this.onProgress) {
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed);
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'tool_use' && block.name) {
                    const input = block.input || {};
                    let detail = '';
                    if (['Write','Edit','Read'].includes(block.name)) detail = input.file_path ? `: ${input.file_path}` : '';
                    else if (block.name === 'Bash') detail = input.command ? `: ${input.command}` : '';
                    else if (['Glob','Grep'].includes(block.name)) detail = input.pattern ? `: ${input.pattern}` : '';
                    else if (block.name === 'WebFetch') detail = input.url ? `: ${input.url}` : '';
                    this.onProgress!(`Tool: ${block.name}${detail}`);
                  } else if (block.type === 'text' && block.text) {
                    const first = (block.text as string).split('\n')[0];
                    if (first.length > 10) this.onProgress!(first);
                  }
                }
              } else if (event.type === 'result') {
                this.onProgress!('Completed');
              } else if (event.type === 'system') {
                this.onProgress!('Agent initialized');
              }
            } catch { /* skip */ }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          stderrBuffer += text + '\n';
          resetIdle();
          if (this.onProgress && text.length <= 500) {
            const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (clean) this.onProgress(clean);
          }
        }
      });

      child.on('close', (code) => {
        clearTimeout(idleTimer);
        clearTimeout(hardCapTimer);
        const lines = stdoutBuffer.split('\n').filter(l => l.trim());
        const outputParts: string[] = [];
        let costUsd = 0;
        let capturedSessionId: string | undefined;
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.session_id) capturedSessionId = event.session_id;
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) outputParts.push(block.text);
              }
            }
            if (event.type === 'result' && typeof event.cost_usd === 'number') costUsd = event.cost_usd;
          } catch { /* skip */ }
        }
        const outputText = outputParts.join('\n');
        const success = code === 0;
        resolve({
          success,
          output: outputText || stderrBuffer || `Process exited with code ${code}`,
          backend: this.name,
          sessionId: capturedSessionId || task.sessionId,
          cost: costUsd > 0 ? costUsd : undefined,
          error: success ? undefined : `Process exited with code ${code}`,
        });
      });
    });
  }
}
