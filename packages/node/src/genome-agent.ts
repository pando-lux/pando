/**
 * GenomeAgent — Phase 25: Self-maintaining Project Genome.
 *
 * Watches git commits, maps code changes to genome components, detects drift
 * between genome claims and actual filesystem state, generates scoped context
 * for manager and worker tasks.
 *
 * The genome lives at {repoDir}/genome/ and is the single source of truth
 * for the project's architecture. This agent keeps it accurate.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, normalize } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GenomeAgentConfig {
  repoDir: string;     // Root of the git repository (e.g., ~/Desktop/pando)
  genomeDir: string;   // Path to genome/ directory (e.g., ~/Desktop/pando/genome)
  dataDir: string;     // Node data dir (~/.pando)
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface ChangedFile {
  path: string;        // Relative to repoDir
  changeType: 'A' | 'M' | 'D' | 'R' | string;  // Added, Modified, Deleted, Renamed
}

export interface ComponentEntry {
  id: string;
  file: string;        // Relative path within genome dir (e.g., "components/scheduler.md")
  type: string;
  domain: string;
  summary: string;
}

export interface FlowEntry {
  id: string;
  file: string;        // Relative path within genome dir (e.g., "flows/task-execution.md")
  summary: string;
}

export interface RuleEntry {
  id: string;
  file: string;        // Relative path within genome dir (e.g., "rules/two-laws.md")
  severity: string;
  summary: string;
}

export interface GenomeRegistry {
  name: string;
  description: string;
  components: ComponentEntry[];
  flows: FlowEntry[];
  rules: RuleEntry[];
}

export interface ComponentFrontmatter {
  id: string;
  type?: string;
  domain?: string;
  entry?: string;       // Source file path (e.g., "packages/node/src/scheduler.ts")
  depends_on?: string[];
  depended_by?: string[];
  rules?: string[];
  last_verified?: string;
  [key: string]: any;
}

export interface FlowFrontmatter {
  id: string;
  components?: string[];
  rules?: string[];
  trigger?: string;
  [key: string]: any;
}

export interface ComponentMatch {
  componentId: string;
  matchType: 'direct' | 'dependency' | 'keyword';
  file: string;        // genome file path
}

export interface DriftIssue {
  componentId: string;
  issue: string;
  severity: 'error' | 'warning';
}

export interface ScopedGenomeContext {
  components: string[];    // markdown content of relevant component files
  flows: string[];         // markdown content of relevant flow files
  rules: string[];         // markdown content of relevant rule files
  summary: string;         // one-paragraph summary of what the scoped context covers
}

// ── GenomeAgent ───────────────────────────────────────────────────────────────

export class GenomeAgent {
  private config: GenomeAgentConfig;
  private registryCache: GenomeRegistry | null = null;
  private frontmatterCache: Map<string, Record<string, any>> = new Map();

  constructor(config: GenomeAgentConfig) {
    this.config = config;
  }

  // ── Git Watching ──────────────────────────────────────────────────────────

  /**
   * Get recent commits since a date (ISO string) or last N commits.
   * Defaults to last 20 commits if no `since` provided.
   */
  getRecentCommits(since?: string): CommitInfo[] {
    try {
      const sinceArg = since ? `--since="${since}"` : '-n 20';
      const raw = execSync(
        `git log ${sinceArg} --pretty=format:"%H|||%an|||%aI|||%s"`,
        { cwd: this.config.repoDir, encoding: 'utf-8', timeout: 10_000, windowsHide: true },
      ).trim();
      if (!raw) return [];
      return raw.split('\n').map(line => {
        const [hash, author, date, ...msgParts] = line.split('|||');
        return { hash, author, date, message: msgParts.join('|||') };
      });
    } catch {
      return [];
    }
  }

  /**
   * Analyze a commit: which files changed?
   */
  analyzeCommit(hash: string): ChangedFile[] {
    try {
      const raw = execSync(
        `git diff-tree --no-commit-id --name-status -r ${hash}`,
        { cwd: this.config.repoDir, encoding: 'utf-8', timeout: 10_000, windowsHide: true },
      ).trim();
      if (!raw) return [];
      return raw.split('\n').map(line => {
        const [changeType, ...pathParts] = line.split('\t');
        return { path: pathParts.join('\t'), changeType: changeType.charAt(0) };
      });
    } catch {
      return [];
    }
  }

  // ── Genome Registry Parsing ───────────────────────────────────────────────

  /**
   * Parse genome.yaml into a structured registry.
   * Uses simple line-by-line parsing (no YAML library dependency).
   */
  parseGenomeYaml(): GenomeRegistry {
    if (this.registryCache) return this.registryCache;

    const yamlPath = join(this.config.genomeDir, 'genome.yaml');
    if (!existsSync(yamlPath)) {
      return { name: 'unknown', description: '', components: [], flows: [], rules: [] };
    }

    const content = readFileSync(yamlPath, 'utf-8');
    const lines = content.split('\n');

    let name = '';
    let description = '';
    const components: ComponentEntry[] = [];
    const flows: FlowEntry[] = [];
    const rules: RuleEntry[] = [];

    // Track which section we're in
    type Section = 'root' | 'components' | 'flows' | 'rules' | 'roadmap';
    let section: Section = 'root';
    let currentItem: Record<string, string> | null = null;
    let currentTarget: 'components' | 'flows' | 'rules' | null = null;

    for (const line of lines) {
      const trimmed = line.trimEnd();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed.trim() === '') continue;

      // Top-level keys
      if (/^name:\s*(.+)/.test(trimmed)) {
        name = trimmed.replace(/^name:\s*/, '').trim();
        continue;
      }
      if (/^description:\s*(.+)/.test(trimmed)) {
        description = trimmed.replace(/^description:\s*/, '').trim();
        continue;
      }

      // Section headers
      if (/^components:/.test(trimmed)) { section = 'components'; currentTarget = 'components'; continue; }
      if (/^flows:/.test(trimmed)) { section = 'flows'; currentTarget = 'flows'; continue; }
      if (/^rules:/.test(trimmed)) { section = 'rules'; currentTarget = 'rules'; continue; }
      if (/^roadmap:/.test(trimmed)) { section = 'roadmap'; currentTarget = null; continue; }

      // Top-level fields we don't track
      if (/^(repo|founder|currency|license|type):/.test(trimmed)) continue;

      // List items within sections
      if (section === 'components' || section === 'flows' || section === 'rules') {
        // New list item
        if (/^\s+-\s+id:\s*(.+)/.test(trimmed)) {
          // Save previous item
          if (currentItem && currentTarget) {
            this.pushItem(currentTarget, currentItem, components, flows, rules);
          }
          currentItem = {};
          const match = trimmed.match(/^\s+-\s+id:\s*(.+)/);
          if (match) currentItem.id = match[1].trim();
          continue;
        }

        // Properties of current item
        if (currentItem && /^\s+\w+:\s*.+/.test(trimmed)) {
          const propMatch = trimmed.match(/^\s+(\w+):\s*(.+)/);
          if (propMatch) {
            const key = propMatch[1].trim();
            let value = propMatch[2].trim();
            // Strip surrounding quotes
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            currentItem[key] = value;
          }
        }
      }
    }

    // Save last item
    if (currentItem && currentTarget) {
      this.pushItem(currentTarget, currentItem, components, flows, rules);
    }

    this.registryCache = { name, description, components, flows, rules };
    return this.registryCache;
  }

  private pushItem(
    target: 'components' | 'flows' | 'rules',
    item: Record<string, string>,
    components: ComponentEntry[],
    flows: FlowEntry[],
    rules: RuleEntry[],
  ): void {
    if (!item.id) return;
    if (target === 'components') {
      components.push({
        id: item.id,
        file: item.file || '',
        type: item.type || '',
        domain: item.domain || '',
        summary: item.summary || '',
      });
    } else if (target === 'flows') {
      flows.push({
        id: item.id,
        file: item.file || '',
        summary: item.summary || '',
      });
    } else if (target === 'rules') {
      rules.push({
        id: item.id,
        file: item.file || '',
        severity: item.severity || '',
        summary: item.summary || '',
      });
    }
  }

  /**
   * Parse YAML-style frontmatter from a markdown file.
   * Returns key-value pairs from the `---` delimited block at the top.
   */
  parseFrontmatter(filePath: string): Record<string, any> {
    const cached = this.frontmatterCache.get(filePath);
    if (cached) return cached;

    if (!existsSync(filePath)) return {};

    const content = readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fmLines = fmMatch[1].split('\n');
    const result: Record<string, any> = {};

    for (const line of fmLines) {
      const match = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
      if (!match) continue;

      const key = match[1].trim();
      let value: any = match[2].trim();

      // Parse arrays: [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          value = [];
        } else {
          value = inner.split(',').map((s: string) => s.trim());
        }
      } else {
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
      }

      result[key] = value;
    }

    this.frontmatterCache.set(filePath, result);
    return result;
  }

  // ── Code-to-Genome Mapping ────────────────────────────────────────────────

  /**
   * Map changed files to genome components by matching against the `entry`
   * field in component frontmatter.
   */
  mapFilesToComponents(files: string[]): ComponentMatch[] {
    const registry = this.parseGenomeYaml();
    const matches: ComponentMatch[] = [];
    const seenIds = new Set<string>();

    for (const comp of registry.components) {
      const mdPath = join(this.config.genomeDir, comp.file);
      const fm = this.parseFrontmatter(mdPath);
      const entry = fm.entry as string | undefined;

      if (!entry) continue;

      // Normalize paths for comparison
      const normalizedEntry = normalize(entry).replace(/\\/g, '/');

      for (const file of files) {
        const normalizedFile = normalize(file).replace(/\\/g, '/');
        if (normalizedFile === normalizedEntry || normalizedFile.startsWith(normalizedEntry.replace(/\.ts$/, ''))) {
          if (!seenIds.has(comp.id)) {
            matches.push({ componentId: comp.id, matchType: 'direct', file: comp.file });
            seenIds.add(comp.id);
          }
        }
      }
    }

    return matches;
  }

  /**
   * Mark a component as recently modified (update last_verified in frontmatter).
   * NOTE: This is a metadata-only operation; actual file writing would require
   * the genome agent daemon. For now, this just clears the frontmatter cache.
   */
  markComponentModified(componentId: string): void {
    // Clear cache so next read picks up any manual changes
    for (const [key] of this.frontmatterCache) {
      if (key.includes(componentId)) {
        this.frontmatterCache.delete(key);
      }
    }
  }

  // ── Drift Detection ───────────────────────────────────────────────────────

  /**
   * Compare genome.yaml entries against the actual filesystem.
   * Checks: does the entry file exist? Are depends_on still valid?
   */
  detectDrift(): DriftIssue[] {
    const registry = this.parseGenomeYaml();
    const issues: DriftIssue[] = [];

    for (const comp of registry.components) {
      const mdPath = join(this.config.genomeDir, comp.file);

      // Check genome .md file exists
      if (!existsSync(mdPath)) {
        issues.push({
          componentId: comp.id,
          issue: `Genome file missing: ${comp.file}`,
          severity: 'error',
        });
        continue;
      }

      // Check entry source file exists
      const fm = this.parseFrontmatter(mdPath);
      const entry = fm.entry as string | undefined;
      if (entry) {
        const entryPath = join(this.config.repoDir, entry);
        if (!existsSync(entryPath)) {
          issues.push({
            componentId: comp.id,
            issue: `Source file missing: ${entry} (declared in entry field)`,
            severity: 'error',
          });
        }
      }

      // Check depends_on references exist as components
      const dependsOn = fm.depends_on as string[] | undefined;
      if (Array.isArray(dependsOn)) {
        for (const depId of dependsOn) {
          const depExists = registry.components.some(c => c.id === depId);
          if (!depExists) {
            issues.push({
              componentId: comp.id,
              issue: `Dependency "${depId}" not found in genome.yaml components`,
              severity: 'warning',
            });
          }
        }
      }
    }

    // Check flow files exist
    for (const flow of registry.flows) {
      const mdPath = join(this.config.genomeDir, flow.file);
      if (!existsSync(mdPath)) {
        issues.push({
          componentId: flow.id,
          issue: `Flow file missing: ${flow.file}`,
          severity: 'error',
        });
      }
    }

    // Check rule files exist
    for (const rule of registry.rules) {
      const mdPath = join(this.config.genomeDir, rule.file);
      if (!existsSync(mdPath)) {
        issues.push({
          componentId: rule.id,
          issue: `Rule file missing: ${rule.file}`,
          severity: 'error',
        });
      }
    }

    return issues;
  }

  // ── New File Detection ────────────────────────────────────────────────────

  /**
   * Find .ts files in packages/node/src/ that are NOT tracked in genome.yaml.
   */
  detectNewFiles(): string[] {
    const registry = this.parseGenomeYaml();

    // Collect all known entry paths from component frontmatter
    const knownEntries = new Set<string>();
    for (const comp of registry.components) {
      const mdPath = join(this.config.genomeDir, comp.file);
      const fm = this.parseFrontmatter(mdPath);
      if (fm.entry) {
        knownEntries.add(normalize(fm.entry as string).replace(/\\/g, '/'));
      }
    }

    // Scan packages/node/src/ for .ts files
    const srcDir = join(this.config.repoDir, 'packages', 'node', 'src');
    if (!existsSync(srcDir)) return [];

    const untracked: string[] = [];
    try {
      const files = readdirSync(srcDir);
      for (const file of files) {
        if (!file.endsWith('.ts')) continue;
        // Skip test files and declaration files
        if (file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;

        const relPath = `packages/node/src/${file}`;
        if (!knownEntries.has(relPath)) {
          untracked.push(relPath);
        }
      }
    } catch {
      // Directory read failed — return empty
    }

    return untracked;
  }

  // ── Scoped Context Generation (THE KEY FUNCTION) ──────────────────────────

  /**
   * Given a task description and/or affected files, return relevant genome
   * sections as scoped context for a worker agent.
   */
  getScopedContext(opts: {
    taskDescription?: string;
    affectedFiles?: string[];
    maxComponents?: number;
  }): ScopedGenomeContext {
    const max = opts.maxComponents ?? 8;
    const registry = this.parseGenomeYaml();

    const matchedComponentIds = new Set<string>();
    const depComponentIds = new Set<string>();
    const matchedFlowIds = new Set<string>();
    const matchedRuleIds = new Set<string>();

    // Step 1: Match by affected files -> component entry fields
    if (opts.affectedFiles && opts.affectedFiles.length > 0) {
      const fileMatches = this.mapFilesToComponents(opts.affectedFiles);
      for (const m of fileMatches) {
        matchedComponentIds.add(m.componentId);
      }
    }

    // Step 2: Resolve depends_on for each matched component (1 level deep)
    for (const compId of matchedComponentIds) {
      const comp = registry.components.find(c => c.id === compId);
      if (!comp) continue;

      const mdPath = join(this.config.genomeDir, comp.file);
      const fm = this.parseFrontmatter(mdPath);

      // Resolve dependencies
      if (Array.isArray(fm.depends_on)) {
        for (const depId of fm.depends_on) {
          if (!matchedComponentIds.has(depId)) {
            depComponentIds.add(depId);
          }
        }
      }

      // Collect rules from component
      if (Array.isArray(fm.rules)) {
        for (const ruleId of fm.rules) {
          matchedRuleIds.add(ruleId);
        }
      }
    }

    // Step 3: Keyword match task description against component and flow summaries
    if (opts.taskDescription) {
      const keywords = this.extractKeywords(opts.taskDescription);

      if (keywords.length > 0) {
        // Match components
        for (const comp of registry.components) {
          if (matchedComponentIds.has(comp.id) || depComponentIds.has(comp.id)) continue;
          const text = `${comp.id} ${comp.summary} ${comp.domain}`.toLowerCase();
          const score = keywords.filter(kw => text.includes(kw)).length;
          if (score >= 2 || (keywords.length <= 3 && score >= 1)) {
            matchedComponentIds.add(comp.id);
          }
        }

        // Match flows
        for (const flow of registry.flows) {
          const text = `${flow.id} ${flow.summary}`.toLowerCase();
          const score = keywords.filter(kw => text.includes(kw)).length;
          if (score >= 1) {
            matchedFlowIds.add(flow.id);
          }
        }
      }
    }

    // Step 4: Find flows that reference matched components (from flow frontmatter)
    for (const flow of registry.flows) {
      const mdPath = join(this.config.genomeDir, flow.file);
      const fm = this.parseFrontmatter(mdPath) as FlowFrontmatter;
      if (Array.isArray(fm.components)) {
        for (const flowCompId of fm.components) {
          if (matchedComponentIds.has(flowCompId)) {
            matchedFlowIds.add(flow.id);

            // Also collect rules from the flow
            if (Array.isArray(fm.rules)) {
              for (const ruleId of fm.rules) {
                matchedRuleIds.add(ruleId);
              }
            }
            break;
          }
        }
      }
    }

    // Step 5: Cap at maxComponents — prioritize direct matches over deps
    const directIds = [...matchedComponentIds].slice(0, max);
    const remainingSlots = max - directIds.length;
    const depIds = [...depComponentIds].slice(0, Math.max(0, remainingSlots));
    const allComponentIds = [...directIds, ...depIds];

    // Step 6: Read the actual .md file content
    const componentContents: string[] = [];
    for (const compId of allComponentIds) {
      const comp = registry.components.find(c => c.id === compId);
      if (!comp) continue;
      const mdPath = join(this.config.genomeDir, comp.file);
      if (existsSync(mdPath)) {
        try {
          componentContents.push(readFileSync(mdPath, 'utf-8'));
        } catch {
          // Skip unreadable files
        }
      }
    }

    const flowContents: string[] = [];
    for (const flowId of matchedFlowIds) {
      const flow = registry.flows.find(f => f.id === flowId);
      if (!flow) continue;
      const mdPath = join(this.config.genomeDir, flow.file);
      if (existsSync(mdPath)) {
        try {
          flowContents.push(readFileSync(mdPath, 'utf-8'));
        } catch {}
      }
    }

    const ruleContents: string[] = [];
    for (const ruleId of matchedRuleIds) {
      const rule = registry.rules.find(r => r.id === ruleId);
      if (!rule) continue;
      const mdPath = join(this.config.genomeDir, rule.file);
      if (existsSync(mdPath)) {
        try {
          ruleContents.push(readFileSync(mdPath, 'utf-8'));
        } catch {}
      }
    }

    // Step 7: Build summary
    const compNames = allComponentIds.join(', ');
    const flowNames = [...matchedFlowIds].join(', ');
    const ruleNames = [...matchedRuleIds].join(', ');
    const parts: string[] = [];
    if (compNames) parts.push(`Components: ${compNames}`);
    if (flowNames) parts.push(`Flows: ${flowNames}`);
    if (ruleNames) parts.push(`Rules: ${ruleNames}`);
    const summary = parts.length > 0
      ? `Scoped genome context covering ${allComponentIds.length} component(s). ${parts.join('. ')}.`
      : 'No genome context matched for this task.';

    return {
      components: componentContents,
      flows: flowContents,
      rules: ruleContents,
      summary,
    };
  }

  /**
   * Resolve a component and its dependency chain (up to `depth` levels).
   * Returns a list of component IDs in dependency order.
   */
  getComponentWithDeps(componentId: string, depth: number = 1): string[] {
    const registry = this.parseGenomeYaml();
    const result: string[] = [componentId];
    const visited = new Set<string>([componentId]);

    let currentLevel = [componentId];
    for (let d = 0; d < depth; d++) {
      const nextLevel: string[] = [];
      for (const compId of currentLevel) {
        const comp = registry.components.find(c => c.id === compId);
        if (!comp) continue;
        const mdPath = join(this.config.genomeDir, comp.file);
        const fm = this.parseFrontmatter(mdPath);
        if (Array.isArray(fm.depends_on)) {
          for (const depId of fm.depends_on) {
            if (!visited.has(depId)) {
              visited.add(depId);
              result.push(depId);
              nextLevel.push(depId);
            }
          }
        }
      }
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return result;
  }

  // ── State Queries ─────────────────────────────────────────────────────────

  /**
   * Read the genome state file (state.md).
   */
  getState(): string {
    const statePath = join(this.config.genomeDir, 'state.md');
    if (!existsSync(statePath)) return '';
    try {
      return readFileSync(statePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Read the "Known Issues" section from state.md.
   */
  getKnownIssues(): string {
    const state = this.getState();
    if (!state) return '';

    const issueStart = state.indexOf('## Known Issues');
    if (issueStart === -1) return '';

    // Find the next ## heading after Known Issues
    const afterStart = state.indexOf('\n## ', issueStart + 15);
    if (afterStart === -1) {
      return state.slice(issueStart).trim();
    }
    return state.slice(issueStart, afterStart).trim();
  }

  /**
   * Read the genome.yaml summary (first 20 lines).
   */
  getGenomeSummary(): string {
    const yamlPath = join(this.config.genomeDir, 'genome.yaml');
    if (!existsSync(yamlPath)) return '';
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const lines = content.split('\n').slice(0, 20);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Read the roadmap summary (first 30 lines).
   */
  getRoadmapSummary(): string {
    const roadmapPath = join(this.config.genomeDir, 'roadmap.md');
    if (!existsSync(roadmapPath)) return '';
    try {
      const content = readFileSync(roadmapPath, 'utf-8');
      const lines = content.split('\n').slice(0, 30);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Check if the genome directory exists.
   */
  isAvailable(): boolean {
    return existsSync(join(this.config.genomeDir, 'genome.yaml'));
  }

  /**
   * Clear all caches (call after genome files change).
   */
  clearCache(): void {
    this.registryCache = null;
    this.frontmatterCache.clear();
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Extract meaningful keywords from a task description.
   * Filters out common stop words and returns lowercase keywords.
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'must',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
      'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
      'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
      'too', 'very', 'just', 'because', 'if', 'when', 'where', 'how',
      'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
      'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their',
      'add', 'update', 'fix', 'implement', 'create', 'remove', 'change',
      'make', 'use', 'new', 'file', 'code', 'function', 'class', 'method',
    ]);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s-_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Deduplicate
    return [...new Set(words)];
  }
}
