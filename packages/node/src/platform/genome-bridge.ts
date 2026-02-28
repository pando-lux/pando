/**
 * GenomeBridge — TypeScript reader for the compiled genome knowledge graph.
 *
 * Reads output/graph.json at runtime. Zero Python dependency.
 * Provides context injection for workers and orchestrator AI prompts.
 *
 * Usage:
 *   const bridge = new GenomeBridge('/path/to/output/graph.json');
 *   const ctx = bridge.contextForTask({ taskDescription: 'fix storage layer' });
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  _type: string;      // 'test', 'entity', 'flow', 'concept', 'invariant', 'lesson', 'decision'
  _name: string;
  _source: string;
  _tags?: string[];   // '@gotcha("...")', etc.
  description?: string;
  summary?: string;
  type?: string;      // subtype: 'e2e', 'regression', 'module', 'service', etc.
  category?: string;
  status?: string;
  validates?: string;
  automatable?: string | boolean;
  steps?: string[];
  expected?: string;
  method?: string;
  path?: string;
  expectedStatus?: number;
  expectedFields?: string[];
  mode?: number;
  nodes_required?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;       // 'VALIDATES', 'TRIGGERED_BY', 'DEPENDS_ON', etc.
  via?: string;
}

export interface CompiledGraph {
  version: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  by_type: Record<string, string[]>;
  stats: Record<string, unknown>;
  compiled_date: string;
}

export interface ContextOpts {
  taskDescription: string;
  role?: string;
  fileScope?: string[];
}

// ---------------------------------------------------------------------------
// GenomeBridge
// ---------------------------------------------------------------------------

export class GenomeBridge {
  private graph: CompiledGraph | null = null;
  private graphPath: string;

  constructor(graphPath: string) {
    this.graphPath = graphPath;
    this.reload();
  }

  /**
   * Reload the graph from disk. Call after recompilation.
   */
  reload(): void {
    try {
      if (!existsSync(this.graphPath)) {
        this.graph = null;
        return;
      }
      const raw = readFileSync(this.graphPath, 'utf-8');
      this.graph = JSON.parse(raw) as CompiledGraph;
    } catch {
      this.graph = null;
    }
  }

  /**
   * Check if the graph is loaded.
   */
  isLoaded(): boolean {
    return this.graph !== null;
  }

  /**
   * Get context relevant to a task. Extracts keywords from the description,
   * finds matching nodes, and returns a formatted string for injection into
   * agent CLAUDE.md or orchestrator AI prompt.
   *
   * Caps output at ~2000 tokens (~8000 chars) to avoid bloating prompts.
   */
  contextForTask(opts: ContextOpts): string {
    if (!this.graph) return '';

    const keywords = this.extractKeywords(opts.taskDescription);
    if (keywords.length === 0) return '';

    const matchedNodes = this.searchNodes(keywords);
    if (matchedNodes.length === 0) return '';

    const sections: string[] = [];
    const MAX_CHARS = 6000;
    let charCount = 0;

    // Group by type — maintain relevance ordering from searchNodes within each group
    const byType: Record<string, GraphNode[]> = {};
    for (const node of matchedNodes) {
      const t = node._type;
      if (!byType[t]) byType[t] = [];
      byType[t].push(node);
    }

    // Flows first (they describe HOW things work — most actionable for agents),
    // then concepts, entities, lessons, decisions, invariants
    for (const type of ['flow', 'concept', 'entity', 'lesson', 'decision', 'invariant']) {
      const nodes = byType[type];
      if (!nodes?.length) continue;

      for (const node of nodes.slice(0, 3)) {
        const line = this.formatNode(node);
        if (charCount + line.length > MAX_CHARS) break;
        sections.push(line);
        charCount += line.length;
      }
    }

    // Tests relevant to matched components
    const testNodes = byType['test'];
    if (testNodes?.length) {
      const failing = testNodes.filter(t => t.status === 'failing');
      const passing = testNodes.filter(t => t.status !== 'failing');

      if (failing.length > 0) {
        sections.push(`\nFailing tests (${failing.length}):`);
        for (const t of failing.slice(0, 5)) {
          const line = `- ${t._name}: ${t.description || ''} [validates: ${t.validates || 'unknown'}]`;
          if (charCount + line.length > MAX_CHARS) break;
          sections.push(line);
          charCount += line.length;
        }
      }

      // Include a few passing tests for context (role-aware)
      if (opts.role === 'tester' || opts.role === 'reviewer') {
        sections.push(`\nRelevant tests (${passing.length} passing):`);
        for (const t of passing.slice(0, 5)) {
          const line = `- ${t._name}: ${t.description || ''} [${t.automatable === 'true' ? 'auto' : 'manual'}]`;
          if (charCount + line.length > MAX_CHARS) break;
          sections.push(line);
          charCount += line.length;
        }
      }
    }

    // Gotchas
    const gotchas = matchedNodes
      .flatMap(n => (n._tags || []))
      .filter(t => t.startsWith('@gotcha'))
      .slice(0, 5);
    if (gotchas.length > 0) {
      sections.push('\nGotchas:');
      for (const g of gotchas) {
        const match = g.match(/@gotcha\("(.+?)"\)/);
        if (match) {
          const line = `- ${match[1]}`;
          if (charCount + line.length > MAX_CHARS) break;
          sections.push(line);
          charCount += line.length;
        }
      }
    }

    return sections.join('\n');
  }

  /**
   * Get all invariants (rules) that apply to files in the given scope.
   */
  rulesForFile(filePath: string): GraphNode[] {
    if (!this.graph) return [];
    const nodes = Object.values(this.graph.nodes);
    return nodes.filter(n =>
      n._type === 'invariant' &&
      n._source &&
      filePath.includes(n._source.replace(/\\/g, '/'))
    );
  }

  /**
   * Get tests that validate a specific invariant.
   */
  testsFor(invariantId: string): GraphNode[] {
    if (!this.graph) return [];
    const testNames = this.graph.edges
      .filter(e => e.type === 'VALIDATES' && e.to === invariantId)
      .map(e => e.from);
    return testNames
      .map(name => this.graph!.nodes[name])
      .filter(Boolean);
  }

  /**
   * Get all currently failing tests.
   */
  failingTests(): GraphNode[] {
    if (!this.graph) return [];
    const testNames = this.graph.by_type['test'] || [];
    return testNames
      .map(name => this.graph!.nodes[name])
      .filter(n => n && n.status === 'failing');
  }

  /**
   * Get all test nodes.
   */
  allTests(): GraphNode[] {
    if (!this.graph) return [];
    const testNames = this.graph.by_type['test'] || [];
    return testNames
      .map(name => this.graph!.nodes[name])
      .filter(Boolean);
  }

  /**
   * Get tests by category.
   */
  testsByCategory(category: string): GraphNode[] {
    return this.allTests().filter(t => t.category === category);
  }

  /**
   * Get a concise brief for a named entity.
   */
  brief(name: string): string {
    if (!this.graph) return '';
    const node = this.graph.nodes[name];
    if (!node) return '';
    return this.formatNode(node);
  }

  /**
   * Search nodes by keyword. Returns matching nodes sorted by relevance.
   */
  search(query: string): GraphNode[] {
    return this.searchNodes(this.extractKeywords(query));
  }

  /**
   * Get graph stats.
   */
  getStats(): { totalNodes: number; testNodes: number; failingTests: number; categories: Record<string, number> } {
    if (!this.graph) return { totalNodes: 0, testNodes: 0, failingTests: 0, categories: {} };

    const tests = this.allTests();
    const categories: Record<string, number> = {};
    for (const t of tests) {
      const cat = t.category || 'uncategorized';
      categories[cat] = (categories[cat] || 0) + 1;
    }

    return {
      totalNodes: Object.keys(this.graph.nodes).length,
      testNodes: tests.length,
      failingTests: this.failingTests().length,
      categories,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private extractKeywords(text: string): string[] {
    // Split on non-alphanumeric, filter stopwords, lowercase
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
      'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
      'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
      'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
      'or', 'if', 'while', 'that', 'this', 'it', 'its', 'what', 'which',
      'who', 'whom', 'these', 'those', 'i', 'me', 'my', 'you', 'your',
      'we', 'our', 'they', 'their', 'he', 'she', 'him', 'her',
    ]);
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
  }

  private searchNodes(keywords: string[]): GraphNode[] {
    if (!this.graph || keywords.length === 0) return [];

    const scored: { node: GraphNode; score: number }[] = [];

    for (const node of Object.values(this.graph.nodes)) {
      let score = 0;

      // Primary fields — matches here are more relevant than step content
      const primaryText = [
        node._name,
        node.description || '',
        node.summary || '',
        node.category || '',
        node.validates || '',
        ...(node._tags || []),
      ].join(' ').toLowerCase();

      // Secondary fields — flow step content (useful but lower signal)
      const stepParts: string[] = [];
      const steps = (node as any)._steps;
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (step.what) stepParts.push(step.what);
          if (step._name) stepParts.push(step._name);
        }
      }
      const stepText = stepParts.join(' ').toLowerCase();

      for (const kw of keywords) {
        // Primary match: name, description, summary — high signal
        if (primaryText.includes(kw)) score += 2;
        // Name match: strongest signal
        if (node._name.toLowerCase().includes(kw)) score += 3;
        // Step match: weaker signal (avoids irrelevant flows ranking high)
        if (stepText.includes(kw)) score += 1;
      }

      if (score > 0) {
        scored.push({ node, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(s => s.node);
  }

  private formatNode(node: GraphNode): string {
    const parts: string[] = [];
    parts.push(`**${node._name}** (${node._type})`);

    // Use description OR summary — flows and concepts often use summary instead of description
    const text = node.description || (node as any).summary;
    if (text) parts.push(`  ${text}`);

    if (node.validates) parts.push(`  Validates: ${node.validates}`);
    if (node._source) parts.push(`  Source: ${node._source}`);

    // Flow nodes: render steps so agents understand the pipeline
    const steps = (node as any)._steps;
    if (Array.isArray(steps) && steps.length > 0) {
      for (const step of steps) {
        const stepName = step._name || '?';
        const target = step._target || step._next || '';
        const what = step.what || '';
        parts.push(`  ${stepName} → ${target}: ${what}`);
      }
    }

    const gotchas = (node._tags || []).filter((t: string) => t.startsWith('@gotcha'));
    for (const g of gotchas) {
      const match = g.match(/@gotcha\("(.+?)"\)/);
      if (match) parts.push(`  ⚠ ${match[1]}`);
    }

    return parts.join('\n');
  }
}

// ---------------------------------------------------------------------------
// GenomeBridgeRegistry — Per-project genome graph management
// ---------------------------------------------------------------------------

const PANDO_PROJECT_ID = '__pando__';

/**
 * Registry that maps project IDs to their own GenomeBridge instances.
 * Council workers on Pando get Pando's genome. Workers on user projects
 * get that project's genome (if compiled) or null.
 */
export class GenomeBridgeRegistry {
  private bridges: Map<string, GenomeBridge> = new Map();

  constructor(pandoGraphPath: string) {
    const pandoBridge = new GenomeBridge(pandoGraphPath);
    this.bridges.set(PANDO_PROJECT_ID, pandoBridge);
  }

  /** Get genome bridge for a project. Returns Pando's bridge for '__pando__'. */
  getForProject(projectId: string | null): GenomeBridge | null {
    if (!projectId) return this.getPandoBridge();
    if (this.bridges.has(projectId)) return this.bridges.get(projectId)!;
    return null;
  }

  /** Register a project's genome graph. Called when a project has output/graph.json. */
  register(projectId: string, graphPath: string): void {
    if (existsSync(graphPath)) {
      this.bridges.set(projectId, new GenomeBridge(graphPath));
    }
  }

  /** Auto-detect and register genome for a project workspace. */
  registerFromWorkspace(projectId: string, workspaceDir: string): boolean {
    const graphPath = join(workspaceDir, 'output', 'graph.json');
    if (existsSync(graphPath)) {
      this.register(projectId, graphPath);
      return true;
    }
    return false;
  }

  /** Get the Pando bridge (backward compat). */
  getPandoBridge(): GenomeBridge {
    return this.bridges.get(PANDO_PROJECT_ID)!;
  }

  /** Check if a project has a registered genome. */
  has(projectId: string): boolean {
    return this.bridges.has(projectId);
  }

  /** Reload all bridges (after recompilation). */
  reloadAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.reload();
    }
  }
}
