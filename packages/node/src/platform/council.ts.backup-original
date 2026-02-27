/**
 * Council — Network Council Selection + Reflection Engine (Phase 50).
 *
 * A rotating group of top-reputation AI-capable nodes that periodically
 * reflect on network state and propose improvements. This is the
 * "self-governance brain" of the network.
 *
 * Council members are selected from known peers based on:
 *   1. Claude Code capability (compute_cpu + claudeCode detail)
 *   2. Reputation score (highest first)
 *   3. Top 3 nodes (or fewer if < 3 AI-capable)
 *
 * Council rotates weekly. Daily reflections assemble a prompt from
 * network state, council minutes, and genome state — the actual AI
 * call is stubbed for now (infrastructure only).
 *
 * State persisted in {dataDir}/council/:
 *   - council-state.json   — current council members, rotation, reflection timestamps
 *   - council-minutes.md   — rolling log of council decisions (last 30 entries)
 *   - last-prompt.md       — most recent assembled reflection prompt
 *   - network-state.md     — written by NetworkState (read-only here)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface CouncilMember {
  peerId: string;
  reputation: number;
  hasClaudeCode: boolean;
  uptimeHours: number;
}

export interface CouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;        // selectedAt + 7 days
  thisNodeOnCouncil: boolean;
}

export interface ReflectionResult {
  timestamp: number;
  type: 'daily' | 'weekly' | 'monthly';
  summary: string;
  proposals: string[];       // governance proposals to create, if any
  minutesEntry: string;      // what to append to council-minutes.md
}

interface PersistedCouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  lastDailyReflection: number;
  lastWeeklyReflection: number;
  lastMonthlyReflection: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const COUNCIL_SIZE = 3;
const ROTATION_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days
const DAILY_MS = 24 * 60 * 60 * 1000;               // 24 hours
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;          // 7 days
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
const CHECK_INTERVAL_MS = 60 * 60 * 1000;            // 1 hour
const MAX_MINUTES_ENTRIES = 30;

// ── Council Class ───────────────────────────────────────────────────────────

export class Council {
  private node: any;       // PandoNode — typed as any to avoid circular imports
  private dataDir: string;
  private councilDir: string;
  private statePath: string;
  private minutesPath: string;
  private promptPath: string;
  private networkStatePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: PersistedCouncilState;

  constructor(node: any, dataDir: string) {
    this.node = node;
    this.dataDir = dataDir;
    this.councilDir = join(dataDir, 'council');
    this.statePath = join(this.councilDir, 'council-state.json');
    this.minutesPath = join(this.councilDir, 'council-minutes.md');
    this.promptPath = join(this.councilDir, 'last-prompt.md');
    this.networkStatePath = join(this.councilDir, 'network-state.md');

    // Ensure council directory exists
    this.ensureDir();

    // Load persisted state or initialize default
    this.state = this.loadState();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Select council members from known peers + self.
   * Filters to AI-capable nodes, sorts by reputation, takes top 3.
   */
  selectCouncil(): CouncilMember[] {
    const candidates: CouncilMember[] = [];

    // 1. Get all known peers from CapabilityRegistry
    const capRegistry = this.node.getCapabilityRegistry?.();
    const allProfiles = capRegistry?.getAllProfiles?.() || [];

    // 2. Include self
    const identity = this.node.getIdentity?.();
    const localPeerId = identity?.peerId || '';

    for (const profile of allProfiles) {
      const peerId = profile.peerId;

      // 3. Filter to nodes with Claude Code capability
      const hasCpu = profile.capabilities?.compute_cpu === true;
      const hasClaudeCode = hasCpu && profile.details?.compute_cpu?.claudeCode === true;
      if (!hasClaudeCode) continue;

      // 4. Get reputation
      const repManager = this.node.getReputationManager?.();
      const repRecord = repManager?.getReputation?.(peerId);
      const reputation = repRecord?.reputationScore ?? 0;

      // Estimate uptime from node process (rough heuristic)
      const uptimeHours = peerId === localPeerId
        ? Math.floor(process.uptime() / 3600)
        : 0; // We don't know remote uptimes; default 0

      candidates.push({
        peerId,
        reputation,
        hasClaudeCode: true,
        uptimeHours,
      });
    }

    // 5. Sort by reputation (highest first)
    candidates.sort((a, b) => b.reputation - a.reputation);

    // 6. Take top N
    const members = candidates.slice(0, COUNCIL_SIZE);

    // Update state
    const now = Date.now();
    this.state.members = members;
    this.state.selectedAt = now;
    this.state.rotatesAt = now + ROTATION_MS;
    this.saveState();

    console.log(`[council] Selected ${members.length} council member(s): [${members.map(m => m.peerId.slice(0, 12)).join(', ')}]`);

    return members;
  }

  /**
   * Check if this node is on the current council.
   */
  isCouncilMember(): boolean {
    const identity = this.node.getIdentity?.();
    if (!identity) return false;
    return this.state.members.some(m => m.peerId === identity.peerId);
  }

  /**
   * Get the current council state.
   */
  getCouncil(): CouncilState {
    const identity = this.node.getIdentity?.();
    return {
      members: [...this.state.members],
      selectedAt: this.state.selectedAt,
      rotatesAt: this.state.rotatesAt,
      thisNodeOnCouncil: identity
        ? this.state.members.some(m => m.peerId === identity.peerId)
        : false,
    };
  }

  /**
   * Run a daily reflection (if this node is on the council).
   * For now, assembles the prompt and logs it — does NOT call Claude Code.
   * Returns null if reflection is not due or this node is not on council.
   */
  async runDailyReflection(): Promise<ReflectionResult | null> {
    if (!this.isCouncilMember()) {
      return null;
    }

    // 1. Read network state
    const networkState = this.readFileSafe(this.networkStatePath, '(no network state available)');

    // 2. Read last 5 entries from council minutes
    const recentMinutes = this.getRecentMinutesEntries(5);

    // 3. Read genome/state.md
    const genomeState = this.readGenomeState();

    // 4. Compose structured prompt
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const councilMembers = this.state.members
      .map(m => `  - ${m.peerId.slice(0, 16)}... (reputation: ${m.reputation.toFixed(2)})`)
      .join('\n');

    const prompt = `# Network Council — Daily Reflection
Date: ${dateStr}
Council Members:
${councilMembers}

## Current Network State
${networkState}

## Genome State (project health)
${genomeState}

## Recent Council Minutes
${recentMinutes || '(no previous minutes)'}

## Instructions
You are a member of the Pando Network Council — a group of top-reputation AI-capable nodes.
Your job is to reflect on the current state of the network and propose improvements.

Please provide:
1. A brief summary of network health (1-3 sentences)
2. Any observations about trends, issues, or opportunities
3. Specific proposals for governance votes (if any changes are needed)
4. Any maintenance actions the network should take

Be concrete and actionable. If everything is healthy, say so — do not invent problems.
Format your response as a council minutes entry.`;

    // 5. Save the assembled prompt for inspection
    try {
      writeFileSync(this.promptPath, prompt, 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to save prompt: ${err.message}`);
    }

    // 6. Log that reflection is ready (actual AI call wired later)
    console.log(`[council] Daily reflection due, prompt ready (${prompt.length} chars)`);

    // Update reflection timestamp
    this.state.lastDailyReflection = Date.now();
    this.saveState();

    // Return a stub result — real reflection will populate this from AI output
    return {
      timestamp: Date.now(),
      type: 'daily',
      summary: `Daily reflection prompt assembled (${prompt.length} chars). AI call pending integration.`,
      proposals: [],
      minutesEntry: `## ${dateStr} — Daily Reflection\n- Prompt assembled (${prompt.length} chars), AI integration pending\n- Council: ${this.state.members.length} members\n`,
    };
  }

  /**
   * Start the council scheduler.
   * Checks every hour if daily reflection is due.
   */
  start(): void {
    if (this.timer) return;

    // Initial council selection if no council exists or rotation is past due
    if (this.state.members.length === 0 || Date.now() > this.state.rotatesAt) {
      this.selectCouncil();
    }

    this.timer = setInterval(() => {
      this.tick();
    }, CHECK_INTERVAL_MS);
    // Do not prevent Node.js from exiting
    if (this.timer.unref) this.timer.unref();

    // Run initial tick
    this.tick();

    console.log(`[council] Started (check interval: ${CHECK_INTERVAL_MS / 60000} min)`);
  }

  /**
   * Stop the council scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[council] Stopped');
  }

  /**
   * Get council minutes text (the full file).
   */
  getMinutes(): string {
    return this.readFileSafe(this.minutesPath, '# Council Minutes\n\n(no entries yet)\n');
  }

  /**
   * Append an entry to council minutes.
   * Keeps the last MAX_MINUTES_ENTRIES entries, trimming older ones.
   */
  appendMinutes(entry: string): void {
    try {
      let existing = '';
      if (existsSync(this.minutesPath)) {
        existing = readFileSync(this.minutesPath, 'utf-8');
      }

      // Parse entries — each entry starts with "## "
      const header = '# Council Minutes\n\n';
      const body = existing.startsWith(header)
        ? existing.slice(header.length)
        : existing.replace(/^# Council Minutes\n*/, '');

      // Split by entry headers
      const entries = body.split(/(?=^## )/m).filter(e => e.trim().length > 0);

      // Add new entry at the top
      entries.unshift(entry.trim());

      // Keep last N entries
      const trimmed = entries.slice(0, MAX_MINUTES_ENTRIES);

      const newContent = header + trimmed.join('\n') + '\n';
      writeFileSync(this.minutesPath, newContent, 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to append minutes: ${err.message}`);
    }
  }

  // ── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Hourly tick — checks if council rotation or daily reflection is due.
   */
  private tick(): void {
    const now = Date.now();

    // Check if council rotation is due
    if (now > this.state.rotatesAt) {
      console.log('[council] Council rotation due — reselecting members');
      this.selectCouncil();
    }

    // Check if daily reflection is due
    if (this.isCouncilMember()) {
      const timeSinceLastDaily = now - (this.state.lastDailyReflection || 0);
      if (timeSinceLastDaily >= DAILY_MS) {
        this.runDailyReflection().then((result) => {
          if (result) {
            this.appendMinutes(result.minutesEntry);
            console.log(`[council] Daily reflection completed — ${result.summary.slice(0, 80)}`);
          }
        }).catch((err) => {
          console.error(`[council] Daily reflection failed: ${err.message}`);
        });
      }

      // Weekly flag check (infrastructure only — actual implementation deferred)
      const timeSinceLastWeekly = now - (this.state.lastWeeklyReflection || 0);
      if (timeSinceLastWeekly >= WEEKLY_MS) {
        this.state.lastWeeklyReflection = now;
        this.saveState();
        console.log('[council] Weekly reflection due (implementation deferred)');
      }

      // Monthly flag check (infrastructure only — actual implementation deferred)
      const timeSinceLastMonthly = now - (this.state.lastMonthlyReflection || 0);
      if (timeSinceLastMonthly >= MONTHLY_MS) {
        this.state.lastMonthlyReflection = now;
        this.saveState();
        console.log('[council] Monthly reflection due (implementation deferred)');
      }
    }
  }

  /**
   * Ensure the council directory exists.
   */
  private ensureDir(): void {
    try {
      if (!existsSync(this.councilDir)) {
        mkdirSync(this.councilDir, { recursive: true });
      }
    } catch (err: any) {
      console.error(`[council] Failed to create council dir: ${err.message}`);
    }
  }

  /**
   * Load persisted council state from disk.
   */
  private loadState(): PersistedCouncilState {
    const defaults: PersistedCouncilState = {
      members: [],
      selectedAt: 0,
      rotatesAt: 0,
      lastDailyReflection: 0,
      lastWeeklyReflection: 0,
      lastMonthlyReflection: 0,
    };

    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
      }
    } catch (err: any) {
      console.error(`[council] Failed to load state: ${err.message}`);
    }

    return defaults;
  }

  /**
   * Save council state to disk.
   */
  private saveState(): void {
    try {
      this.ensureDir();
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Read a file safely — returns fallback on any error.
   */
  private readFileSafe(path: string, fallback: string): string {
    try {
      if (existsSync(path)) {
        return readFileSync(path, 'utf-8');
      }
    } catch {}
    return fallback;
  }

  /**
   * Read the last N entries from council minutes.
   */
  private getRecentMinutesEntries(count: number): string {
    const content = this.readFileSafe(this.minutesPath, '');
    if (!content) return '';

    // Parse entries — each starts with "## "
    const entries = content.split(/(?=^## )/m).filter(e => e.trim().length > 0 && e.startsWith('## '));
    return entries.slice(0, count).join('\n');
  }

  /**
   * Read genome/state.md from the project root.
   * Tries process.cwd() and common paths.
   */
  private readGenomeState(): string {
    const candidates = [
      join(process.cwd(), 'genome', 'state.md'),
      join(this.dataDir, '..', 'genome', 'state.md'),
    ];

    for (const path of candidates) {
      try {
        if (existsSync(path)) {
          const content = readFileSync(path, 'utf-8');
          // Truncate if very large (keep first 4000 chars for prompt)
          if (content.length > 4000) {
            return content.slice(0, 4000) + '\n\n...(truncated)';
          }
          return content;
        }
      } catch {}
    }

    return '(genome/state.md not found)';
  }
}
