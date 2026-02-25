/**
 * SmartRouter — Phase 18.4/18.5: Context Detection + Complexity Estimation.
 *
 * Pure heuristic classifier, context detector, and complexity estimator.
 * No LLM required — deterministic, zero-cost, runs before task creation.
 *
 * Architecture: sits between user input and task creation.
 * The Doorman (api-server.ts) handles intent classification via LLM.
 * SmartRouter adds heuristic context detection + complexity scoring on top.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'project';

export type RouterCategory = 'search' | 'network' | 'task' | 'governance' | 'project';

export interface ClassificationInput {
  /** Coarse category inferred from user intent. */
  category: RouterCategory;
  /** Actual file paths detected from the user message. */
  contextFiles: string[];
  /** Scope area — e.g. 'gateway', 'node', 'api', 'full-stack'. */
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

// ── Context detection maps ────────────────────────────────────────────────────

/**
 * Maps keyword patterns to the actual file paths they imply.
 * Each entry: [regex, ...file paths].
 *
 * File paths are relative to the pando repo root.
 */
const CONTEXT_MAP: Array<[RegExp, ...string[]]> = [
  // ── Gateway pages ────────────────────────────────────────────────────────
  [/\bscheduler\s+page\b|\bscheduler\s+tab\b|\btask\s+page\b/i,
    'packages/gateway/app/scheduler/page.tsx'],
  [/\bmonitor\s+page\b|\bhealth\s+page\b|\bmonitor\s+tab\b/i,
    'packages/gateway/app/monitor/page.tsx'],
  [/\bwallet\s+page\b|\bwallet\s+tab\b|\btransfer\s+page\b/i,
    'packages/gateway/app/wallet/page.tsx'],
  [/\bnetwork\s+page\b|\bpeers?\s+page\b|\bnetwork\s+tab\b/i,
    'packages/gateway/app/network/page.tsx'],
  [/\bsearch\s+page\b|\bcontent\s+search\b|\bexplore\s+page\b/i,
    'packages/gateway/app/search/page.tsx',
    'packages/gateway/app/explore/page.tsx'],
  [/\bgovernance\s+page\b|\bgovernance\s+tab\b|\bproposals?\s+page\b/i,
    'packages/gateway/app/governance/page.tsx'],
  [/\bcouncil\s+page\b|\bcouncil\s+tab\b/i,
    'packages/gateway/app/council/page.tsx'],
  [/\bagents?\s+page\b|\bagent\s+list\b|\bagent\s+tab\b/i,
    'packages/gateway/app/agents/page.tsx'],
  [/\bchat\s+page\b|\bchat\s+tab\b|\bchat\s+interface\b/i,
    'packages/gateway/app/chat/page.tsx'],
  [/\bmarketplace\s+page\b|\bmarketplace\s+tab\b/i,
    'packages/gateway/app/marketplace/page.tsx'],
  [/\bprojects?\s+page\b|\bprojects?\s+tab\b/i,
    'packages/gateway/app/projects/page.tsx'],
  [/\bresources?\s+page\b|\bresources?\s+tab\b/i,
    'packages/gateway/app/resources/page.tsx'],
  [/\bhome\s+page\b|\blanding\s+page\b|\bmain\s+page\b/i,
    'packages/gateway/app/page.tsx'],

  // ── Gateway features ─────────────────────────────────────────────────────
  [/\bdark\s+mode\b|\btheme\s+toggle\b|\blight\s+mode\b|\bcolor\s+scheme\b/i,
    'packages/gateway/app/layout.tsx',
    'packages/gateway/components/ThemeToggle.tsx'],
  [/\bnavbar\b|\bnav\s+bar\b|\bnavigation\b|\bheader\b/i,
    'packages/gateway/components/NavBar.tsx'],
  [/\blayout\b/i,
    'packages/gateway/app/layout.tsx'],

  // ── Node API layer ────────────────────────────────────────────────────────
  [/\btransfer\b|\bsend\s+lux\b|\bpayment\b|\bpay\b/i,
    'packages/node/src/api/kernel-api.ts',
    'packages/node/src/core/payment-gate.ts'],
  [/\bbalance\b|\bwallet\b|\blux\b/i,
    'packages/node/src/api/kernel-api.ts'],
  [/\bhealth\s+endpoint\b|\b\/health\b|\bhealth\s+check\b/i,
    'packages/node/src/api/kernel-api.ts'],
  [/\bstatus\s+endpoint\b|\b\/status\b/i,
    'packages/node/src/api/kernel-api.ts'],
  [/\bapi\s+server\b|\bfastify\b|\bapi\s+endpoint\b|\bhttp\s+api\b/i,
    'packages/node/src/api/api-server.ts'],
  [/\bplatform\s+api\b|\bchat\s+endpoint\b|\bmessage\s+endpoint\b/i,
    'packages/node/src/api/platform-api.ts'],
  [/\bcore\s+api\b/i,
    'packages/node/src/api/core-api.ts'],

  // ── Node core components ─────────────────────────────────────────────────
  [/\bscheduler\b(?!\s+page|\s+tab)/i,
    'packages/node/src/platform/scheduler.ts'],
  [/\btask.?queue\b|\btask\s+queue\b/i,
    'packages/node/src/platform/task-queue.ts'],
  [/\btask.?database\b|\btask\s+db\b/i,
    'packages/node/src/platform/task-database.ts'],
  [/\bagent.?manager\b/i,
    'packages/node/src/core/agent-manager.ts'],
  [/\bagent\.ts\b|\bagent\s+class\b|\bbaseagent\b/i,
    'packages/node/src/core/agent.ts'],
  [/\bbridge.?queue\b/i,
    'packages/node/src/core/bridge-queue.ts'],
  [/\bupgrade.?protocol\b|\bupgrade\s+protocol\b/i,
    'packages/node/src/core/upgrade-protocol.ts'],
  [/\bpayment.?gate\b|\bpayment\s+gate\b/i,
    'packages/node/src/core/payment-gate.ts'],
  [/\bgovernance\b(?!\s+page|\s+tab)/i,
    'packages/node/src/kernel/governance.ts'],
  [/\bhealth\s+monitor\b|\bmonitor\.ts\b/i,
    'packages/node/src/kernel/monitor.ts'],
  [/\bnetwork\b(?!\s+page|\s+tab)/i,
    'packages/node/src/kernel/network.ts'],
  [/\bsync\b|\bsynchroni/i,
    'packages/node/src/kernel/sync.ts'],
  [/\bledger\b|\baccounts\b/i,
    'packages/node/src/index.ts'],
  [/\breputation\b/i,
    'packages/node/src/kernel/reputation.ts'],
  [/\bsecurity\b|\bguardrail/i,
    'packages/node/src/kernel/guardrails.ts',
    'packages/node/src/kernel/security-monitor.ts'],
  [/\bemission\b|\bwitness\b/i,
    'packages/node/src/kernel/emission-witness.ts'],
  [/\bclaudebackend\b|\bai.?backend\b|\bai\s+backend\b/i,
    'packages/node/src/core/ai-backend-claude.ts',
    'packages/node/src/core/ai-backend.ts'],
  [/\bdeploy.?manager\b|\bdeployment\b/i,
    'packages/node/src/core/deploy-manager.ts'],
  [/\bresource.?registry\b/i,
    'packages/node/src/platform/resource-registry.ts'],
  [/\bresource.?router\b/i,
    'packages/node/src/platform/resource-router.ts'],
  [/\bresource.?marketplace\b|\bmarketplace\b(?!\s+page)/i,
    'packages/node/src/platform/resource-marketplace.ts'],
  [/\bproject.?store\b|\bproject.?registry\b/i,
    'packages/node/src/platform/project-store.ts',
    'packages/node/src/platform/project-registry.ts'],
  [/\bpipeline\b/i,
    'packages/node/src/platform/pipeline-runner.ts'],
  [/\bqa.?runner\b|\bqa\s+runner\b/i,
    'packages/node/src/platform/qa-runner.ts'],
  [/\bsmart.?router\b/i,
    'packages/node/src/smart-router.ts'],

  // ── Explicit path fragments ───────────────────────────────────────────────
  // e.g. "fix packages/node/src/scheduler.ts" or "change src/kernel/monitor.ts"
];

/** Regex that matches an explicit relative file path in the message. */
const EXPLICIT_PATH_RE = /\b(packages\/[\w/-]+\.(?:ts|tsx|js|jsx|json|md|css|html))\b/gi;

// ── Project-scope keywords ───────────────────────────────────────────────────

const PROJECT_KEYWORDS = /\b(full.?stack|entire|whole|complete|end.?to.?end|from scratch|new app|new platform|new product|new service|new website|build me a|create a|make a|multi.?step|multi.?phase)\b/i;

// ── Context detection ────────────────────────────────────────────────────────

/**
 * Detect context files from a raw user message.
 * Returns deduplicated list of relative file paths.
 */
export function detectContextFiles(message: string): string[] {
  const found = new Set<string>();

  // Explicit path references (e.g. "packages/node/src/scheduler.ts")
  for (const m of message.matchAll(EXPLICIT_PATH_RE)) {
    found.add(m[1]);
  }

  // Keyword-to-file mapping
  for (const [pattern, ...paths] of CONTEXT_MAP) {
    if (pattern.test(message)) {
      for (const p of paths) found.add(p);
    }
  }

  return [...found];
}

// ── estimateComplexity ───────────────────────────────────────────────────────

/**
 * Estimate task complexity from a classification result.
 * Pure heuristics — no LLM, deterministic, zero cost.
 *
 * Rules (in priority order):
 *  project   — explicit project keywords OR inputLength > 500
 *  complex   — category=governance OR contextFiles.length >= 5
 *  moderate  — contextFiles.length 3-4 OR category=task
 *  simple    — contextFiles.length 1-2
 *  trivial   — contextFiles.length=0 AND category=search|network
 */
export function estimateComplexity(input: ClassificationInput): ComplexityEstimate {
  const { category, contextFiles, affectedArea, inputLength = 0, isProjectScope = false } = input;
  const fileCount = contextFiles.length;

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
  if (category === 'governance' || fileCount >= 5) {
    const reason = category === 'governance'
      ? 'Governance category — requires proposal, vote, and node-wide rollout'
      : `Wide blast radius: ${fileCount} files affected`;
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
  if (fileCount >= 3 || category === 'task') {
    const scope = affectedArea ? ` (${affectedArea})` : '';
    return {
      complexity: 'moderate',
      estimatedSubtasks: 3,
      estimatedCostLux: 15,
      estimatedTimeMinutes: 15,
      requiresApproval: false,
      reasoning: `Moderate scope${scope}: ${fileCount} file(s), category=${category}`,
    };
  }

  // ── simple ────────────────────────────────────────────────────────────────
  if (fileCount >= 1) {
    return {
      complexity: 'simple',
      estimatedSubtasks: 1,
      estimatedCostLux: 5,
      estimatedTimeMinutes: 5,
      requiresApproval: false,
      reasoning: `Small change: ${fileCount} file(s) affected`,
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
 * SmartRouter classifies a raw user message, detects context files,
 * and attaches a complexity estimate.
 *
 * Used before task creation so callers can gate on requiresApproval
 * or surface cost/time estimates to the user.
 */
export class SmartRouter {
  /**
   * Classify a raw user message and attach a complexity estimate.
   * Zero external calls — pure keyword heuristics.
   *
   * Returns:
   *   category      — search | network | task | governance | project
   *   contextFiles  — actual file paths detected from the message
   *   affectedArea  — 'gateway' | 'node' | 'api' | 'full-stack' | undefined
   *   estimate      — ComplexityEstimate with Lux cost, time, approval flag
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

    // ── Context file detection ────────────────────────────────────────────
    const contextFiles = detectContextFiles(message);

    // ── Affected area ──────────────────────────────────────────────────────
    let affectedArea: string | undefined;
    if (/\bgateway\b/.test(lower)) affectedArea = 'gateway';
    else if (/\bfrontend\b/.test(lower)) affectedArea = 'gateway';
    else if (/\bbackend\b/.test(lower)) affectedArea = 'node';
    else if (/\bfull.?stack\b/.test(lower)) affectedArea = 'full-stack';
    else if (/\bapi\b/.test(lower)) affectedArea = 'api';
    else if (/\bnode\b/.test(lower)) affectedArea = 'node';
    else if (contextFiles.some(f => f.startsWith('packages/gateway'))) affectedArea = 'gateway';
    else if (contextFiles.some(f => f.startsWith('packages/node'))) affectedArea = 'node';

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
