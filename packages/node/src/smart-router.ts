/**
 * SmartRouter — Phase 18.5: Complexity and Resource Estimation.
 *
 * Pure heuristic classifier + complexity estimator. No LLM required.
 * Runs before task creation so users see estimated cost and scope
 * before any agent is spawned.
 *
 * Architecture: sits between user input and task creation.
 * The Doorman (api-server.ts) handles intent classification via LLM.
 * SmartRouter adds heuristic complexity scoring on top.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'project';

export type RouterCategory = 'search' | 'network' | 'task' | 'governance' | 'project';

export interface ClassificationInput {
  /** Coarse category inferred from user intent. */
  category: RouterCategory;
  /** Number of source files the task is expected to touch. */
  contextFiles: number;
  /** Scope descriptor — e.g. 'single-component', 'module', 'full-stack'. */
  affectedArea?: string;
  /** Raw user message length (characters). */
  inputLength?: number;
  /** Whether the message contains explicit project-scope keywords. */
  isProjectScope?: boolean;
}

export interface ComplexityEstimate {
  complexity: ComplexityLevel;
  estimatedSubtasks: number;
  estimatedCostLux: number;
  estimatedTimeMinutes: number;
  requiresApproval: boolean;
  reasoning: string;
}

export interface RouterResult extends ClassificationInput {
  estimate: ComplexityEstimate;
}

// ── Project-scope keywords ───────────────────────────────────────────────────

const PROJECT_KEYWORDS = /\b(full.?stack|entire|whole|complete|end.?to.?end|from scratch|new app|new platform|new product|new service|new website|build me a|create a|make a|multi.?step|multi.?phase)\b/i;

// ── estimateComplexity ───────────────────────────────────────────────────────

/**
 * Estimate task complexity from a classification result.
 * Pure heuristics — no LLM, deterministic, zero cost.
 *
 * Rules (in priority order):
 *  project   — explicit project keywords OR inputLength > 500
 *  complex   — category=governance OR contextFiles >= 5
 *  moderate  — contextFiles 3-4
 *  simple    — contextFiles 1-2
 *  trivial   — contextFiles=0 AND category=search|network
 */
export function estimateComplexity(input: ClassificationInput): ComplexityEstimate {
  const { category, contextFiles, affectedArea, inputLength = 0, isProjectScope = false } = input;

  // ── project ──────────────────────────────────────────────────────────────
  if (isProjectScope || inputLength > 500) {
    return {
      complexity: 'project',
      estimatedSubtasks: 10,
      estimatedCostLux: 200,
      estimatedTimeMinutes: 240,
      requiresApproval: true,
      reasoning: isProjectScope
        ? 'Explicit project-scope keywords detected — full build pipeline required'
        : `Long request (${inputLength} chars) implies multi-feature project`,
    };
  }

  // ── complex ───────────────────────────────────────────────────────────────
  if (category === 'governance' || contextFiles >= 5) {
    const reason = category === 'governance'
      ? 'Governance category — requires proposal, vote, and node-wide rollout'
      : `Wide blast radius: ${contextFiles} files affected`;
    return {
      complexity: 'complex',
      estimatedSubtasks: 5,
      estimatedCostLux: 50,
      estimatedTimeMinutes: 60,
      requiresApproval: true,
      reasoning: reason,
    };
  }

  // ── moderate ──────────────────────────────────────────────────────────────
  if (contextFiles >= 3 || category === 'task') {
    const scope = affectedArea ? ` (${affectedArea})` : '';
    return {
      complexity: 'moderate',
      estimatedSubtasks: 3,
      estimatedCostLux: 15,
      estimatedTimeMinutes: 15,
      requiresApproval: false,
      reasoning: `Moderate scope${scope}: ${contextFiles} file(s), category=${category}`,
    };
  }

  // ── simple ────────────────────────────────────────────────────────────────
  if (contextFiles >= 1) {
    return {
      complexity: 'simple',
      estimatedSubtasks: 1,
      estimatedCostLux: 5,
      estimatedTimeMinutes: 5,
      requiresApproval: false,
      reasoning: `Small change: ${contextFiles} file(s) affected`,
    };
  }

  // ── trivial ───────────────────────────────────────────────────────────────
  return {
    complexity: 'trivial',
    estimatedSubtasks: 0,
    estimatedCostLux: 0,
    estimatedTimeMinutes: 0,
    requiresApproval: false,
    reasoning: `No file changes expected — ${category} query answered directly`,
  };
}

// ── SmartRouter ───────────────────────────────────────────────────────────────

/**
 * SmartRouter classifies a raw user message into a RouterCategory,
 * estimates file scope, then attaches a ComplexityEstimate.
 *
 * Used before task creation so callers can gate on requiresApproval
 * or surface cost/time estimates to the user.
 */
export class SmartRouter {
  /**
   * Classify a raw user message and attach a complexity estimate.
   * Zero external calls — pure keyword heuristics.
   */
  classify(message: string): RouterResult {
    const lower = message.toLowerCase();
    const inputLength = message.length;
    const isProjectScope = PROJECT_KEYWORDS.test(message);

    // ── Category detection ────────────────────────────────────────────────
    let category: RouterCategory = 'task'; // default

    if (/\b(search|find|look up|query|list|show|status|balance|peers|help|what|who|how|why|when)\b/.test(lower)) {
      category = 'search';
    } else if (/\b(peers|nodes|network|topology|connect|disconnect|gossip|sync|propagat)\b/.test(lower)) {
      category = 'network';
    } else if (/\b(govern|proposal|vote|upgrade|rollout|council|phase|deploy.*node|node.*deploy)\b/.test(lower)) {
      category = 'governance';
    } else if (isProjectScope) {
      category = 'project';
    }

    // ── Context file count heuristic ──────────────────────────────────────
    // Count file-like tokens (*.ts, *.tsx, *.js, etc.) mentioned in the message
    const fileRefs = (message.match(/\b\w[\w/-]*\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs|sh)\b/gi) || []).length;

    // Add implied file count based on scope keywords
    let impliedFiles = 0;
    if (/\b(endpoint|route|api)\b/.test(lower)) impliedFiles += 2;
    if (/\b(component|page|view)\b/.test(lower)) impliedFiles += 1;
    if (/\b(database|schema|migration)\b/.test(lower)) impliedFiles += 2;
    if (/\b(test|spec)\b/.test(lower)) impliedFiles += 1;
    if (/\b(refactor|rewrite)\b/.test(lower)) impliedFiles += 3;

    const contextFiles = fileRefs + impliedFiles;

    // ── Affected area ──────────────────────────────────────────────────────
    let affectedArea: string | undefined;
    if (/\bfrontend\b/.test(lower)) affectedArea = 'frontend';
    else if (/\bbackend\b/.test(lower)) affectedArea = 'backend';
    else if (/\bfull.?stack\b/.test(lower)) affectedArea = 'full-stack';
    else if (/\bapi\b/.test(lower)) affectedArea = 'api';
    else if (/\bui\b/.test(lower)) affectedArea = 'ui';

    const classInput: ClassificationInput = {
      category,
      contextFiles,
      affectedArea,
      inputLength,
      isProjectScope,
    };

    return {
      ...classInput,
      estimate: estimateComplexity(classInput),
    };
  }
}
