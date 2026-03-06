import * as fs from 'fs';
import * as path from 'path';
import type { Playbook, PlaybookStep, StepAction } from '../types';

// ── Valid step actions (must match StepAction union in types.ts) ────

const VALID_ACTIONS: ReadonlySet<string> = new Set<StepAction>([
  'navigate',
  'click',
  'fill',
  'select',
  'screenshot',
  'assert_text',
  'assert_visible',
  'assert_hidden',
  'assert_url',
  'assert_status',
  'api_call',
  'wait',
  'evaluate',
  'hover',
  'press_key',
  'scroll',
  'custom',
]);

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate raw data as a Playbook, applying defaults and throwing on
 * invalid shape.  Returns a fully-typed Playbook.
 */
export function validatePlaybook(data: unknown): Playbook {
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new Error('Playbook must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  // -- name (required, non-empty string) --
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new Error('Playbook "name" is required and must be a non-empty string');
  }

  // -- steps (required, non-empty array) --
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('Playbook "steps" is required and must be a non-empty array');
  }

  // Validate each step
  const steps: PlaybookStep[] = obj.steps.map((raw: unknown, i: number) => {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      throw new Error(`Step ${i}: must be a non-null object`);
    }

    const step = raw as Record<string, unknown>;

    // action is required and must be a valid StepAction
    if (typeof step.action !== 'string' || !VALID_ACTIONS.has(step.action)) {
      throw new Error(
        `Step ${i}: "action" is required and must be one of: ${[...VALID_ACTIONS].join(', ')}. Got: ${String(step.action)}`,
      );
    }

    // Must have at least target or prompt
    const hasTarget = typeof step.target === 'string' && step.target.length > 0;
    const hasPrompt = typeof step.prompt === 'string' && step.prompt.length > 0;
    if (!hasTarget && !hasPrompt) {
      throw new Error(`Step ${i}: must have at least "target" or "prompt"`);
    }

    const validated: PlaybookStep = {
      action: step.action as StepAction,
    };

    if (typeof step.target === 'string') validated.target = step.target;
    if (typeof step.verify === 'string') validated.verify = step.verify;
    if (typeof step.screenshot === 'boolean') validated.screenshot = step.screenshot;
    if (typeof step.expected === 'string') validated.expected = step.expected;
    if (typeof step.value === 'string') validated.value = step.value;
    if (typeof step.prompt === 'string') validated.prompt = step.prompt;
    if (typeof step.live_only === 'boolean') validated.live_only = step.live_only;
    if (typeof step.auth === 'string') validated.auth = step.auth;
    if (typeof step.method === 'string') validated.method = step.method;
    if (step.body !== undefined) {
      validated.body = typeof step.body === 'string'
        ? step.body
        : step.body as Record<string, unknown>;
    }

    return validated;
  });

  // -- Apply defaults for optional top-level fields --
  const description = typeof obj.description === 'string' ? obj.description : '';
  const version = typeof obj.version === 'string' ? obj.version : '1.0.0';
  const mode = obj.mode === 'scripted' || obj.mode === 'live' ? obj.mode : 'both' as any;
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [];
  const prerequisites = Array.isArray(obj.prerequisites)
    ? obj.prerequisites.filter((p): p is string => typeof p === 'string')
    : [];

  return {
    name: obj.name as string,
    description,
    version,
    mode: mode === 'both' ? 'scripted' : mode, // Playbook.mode is TestMode ('scripted' | 'live'); default to 'scripted'
    tags,
    prerequisites,
    steps,
  };
}

// ── Single-file loader ─────────────────────────────────────────────

/**
 * Read a JSON playbook file from disk, validate it, and return a typed
 * Playbook object.  Throws if the file is missing or the content is
 * invalid.
 */
export function loadPlaybook(filePath: string): Playbook {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Playbook file not found: ${absolute}`);
  }

  const raw = fs.readFileSync(absolute, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse playbook JSON at ${absolute}: ${(err as Error).message}`);
  }

  return validatePlaybook(parsed);
}

// ── Directory loader ───────────────────────────────────────────────

/**
 * Load every `.json` file in `dirPath` as a Playbook.  Non-JSON files
 * are silently skipped.  Invalid playbooks throw.
 */
export function loadPlaybooksFromDir(dirPath: string): Playbook[] {
  const absolute = path.resolve(dirPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`Playbook directory not found: ${absolute}`);
  }

  const files = fs.readdirSync(absolute)
    .filter(f => f.endsWith('.json'))
    .sort(); // deterministic order

  return files.map(f => loadPlaybook(path.join(absolute, f)));
}

// ── Variable resolution ────────────────────────────────────────────

/**
 * Deep-clone a Playbook and replace every `{{VAR}}` occurrence in all
 * string-valued fields with the matching value from `vars`.
 *
 * Replacement is case-sensitive and applies to:
 *  - Top-level string fields (name, description, version)
 *  - All string fields inside each step (target, verify, expected,
 *    value, prompt, auth, method, body when body is a string)
 */
export function resolvePlaybookVariables(
  playbook: Playbook,
  vars: Record<string, string>,
): Playbook {
  const replacer = (text: string): string => {
    let result = text;
    for (const [key, val] of Object.entries(vars)) {
      // Match {{KEY}} patterns
      const pattern = new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, 'g');
      result = result.replace(pattern, val);
    }
    return result;
  };

  const resolveStep = (step: PlaybookStep): PlaybookStep => {
    const resolved: PlaybookStep = { ...step };
    if (resolved.target) resolved.target = replacer(resolved.target);
    if (resolved.verify) resolved.verify = replacer(resolved.verify);
    if (resolved.expected) resolved.expected = replacer(resolved.expected);
    if (resolved.value) resolved.value = replacer(resolved.value);
    if (resolved.prompt) resolved.prompt = replacer(resolved.prompt);
    if (resolved.auth) resolved.auth = replacer(resolved.auth);
    if (resolved.method) resolved.method = replacer(resolved.method);
    if (typeof resolved.body === 'string') {
      resolved.body = replacer(resolved.body);
    } else if (resolved.body && typeof resolved.body === 'object') {
      // Deep-replace strings within a body object
      resolved.body = JSON.parse(replacer(JSON.stringify(resolved.body)));
    }
    return resolved;
  };

  return {
    name: replacer(playbook.name),
    description: replacer(playbook.description),
    version: playbook.version,
    mode: playbook.mode,
    tags: playbook.tags.map(replacer),
    prerequisites: playbook.prerequisites.map(replacer),
    steps: playbook.steps.map(resolveStep),
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
