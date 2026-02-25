# AI Backend System

**Layer:** Core (Layer 1)
**Status:** v2.1 — new
**Source files:**
- `packages/node/src/core/ai-backend.ts` — AIBackend interface + AITask/AIResult types
- `packages/node/src/core/ai-backend-registry.ts` — AIBackendRegistry class
- `packages/node/src/core/ai-backend-claude.ts` — Claude Code implementation
- `packages/node/src/core/ai-backend-ollama.ts` — Ollama stub (detect only, execute not built)

## Purpose

Decouples the agent system from any specific AI provider. Agents never spawn `claude` directly — they call the registry, which returns the best available backend. This makes adding Ollama, ComfyUI, or any future backend a one-file change.

## Interface

```typescript
interface AIBackend {
  readonly name: string;            // 'claude-code', 'ollama', 'comfyui'
  readonly capabilities: string[];  // ['text-generation', 'code-execution', ...]
  available: boolean;               // Detected at startup

  execute(task: AITask): Promise<AIResult>;
  detect(): Promise<boolean>;       // Check if backend is installed/running
}

interface AITask {
  type: 'text' | 'code' | 'image';
  prompt: string;
  context?: string;
  sessionId?: string;               // For Claude Code --resume
  options?: Record<string, unknown>;
}

interface AIResult {
  success: boolean;
  output: string;
  backend: string;                  // Which backend handled it
  sessionId?: string;               // For session resume
  cost?: number;                    // Lux cost estimate (future)
  error?: string;
}
```

## Registry

```typescript
class AIBackendRegistry {
  register(backend: AIBackend): void;
  detectAll(): Promise<void>;              // Runs detect() on all registered backends
  getBest(taskType: string): AIBackend | null;  // Returns best available for task type
  getAll(): AIBackend[];
  getAvailable(): AIBackend[];
}
```

## Implemented Backends

### ClaudeBackend (`ai-backend-claude.ts`)
- **detect():** `claude --version` → true if exit code 0
- **capabilities:** `['text-generation', 'code-execution']`
- **execute():** Spawns `claude -p --output-format stream-json [--resume <sessionId>] [--continue]`
- Handles full session lifecycle (spawn, resume, stream collect, error handling)
- Returns sessionId in AIResult for next resume

### OllamaBackend (`ai-backend-ollama.ts`)
- **detect():** `fetch('http://localhost:11434/api/tags')` → true if 200
- **capabilities:** `['text-generation']`
- **execute():** Returns `{ success: false, error: 'not yet implemented' }`
- Stub only — proves the interface works, implementation deferred

## How Agents Use It

In `agent.ts`, the agent receives AIBackendRegistry via constructor injection:

```typescript
class Agent {
  constructor(
    private backendRegistry: AIBackendRegistry,
    // ... other deps
  ) {}

  async runTask(prompt: string): Promise<string> {
    const backend = this.backendRegistry.getBest('code-execution');
    if (!backend) throw new Error('No AI backend available for code-execution');
    const result = await backend.execute({
      type: 'code',
      prompt,
      sessionId: this.state.sessionId,
    });
    if (result.sessionId) this.state.sessionId = result.sessionId;
    return result.output;
  }
}
```

## Startup Sequence

In `index.ts` (PandoNode):
1. Create AIBackendRegistry
2. Register ClaudeBackend, OllamaBackend
3. Call `await registry.detectAll()` — sets `available` on each backend
4. Pass registry to AgentManager

## Future Backends (stubs to be filled)
- `ai-backend-comfyui.ts` — Image generation via ComfyUI local server
- `ai-backend-openai.ts` — OpenAI API (for nodes that contributed API key)
- `ai-backend-gemini.ts` — Gemini API (same)

## Rules
- Agents NEVER import or spawn claude directly — always via registry
- Registry is created in Layer 1 (core) and passed down — NOT a singleton
- `detect()` runs once at startup, not per-request (too slow)
- If no backend available: agent fails with clear error, not silent hang
