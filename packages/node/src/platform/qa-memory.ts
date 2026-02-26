/**
 * QA Memory — Persistent store of past QA results (Phase 101d).
 *
 * Learns from test failures to improve future adversarial QA.
 * Each entry records a flow test result with verdict, failure details,
 * and edge cases. The briefing method provides historical context
 * to QA agents so they can focus on previously-broken areas.
 *
 * Stored at {dataDir}/council/qa-memory.json (max 500 entries, FIFO).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// @know entity QAMemory {
//   type: service
//   blueprint: GOVERNANCE
//   status: active
//   description: "Phase 101d: Persistent store of past QA results. Learns from test failures to feed historical context into adversarial QA agents. Stored at {dataDir}/council/qa-memory.json (max 500 entries)."
//   depends_on: [Council]
//   @gotcha("Entries are FIFO — oldest entries are dropped when max is reached. Flow names should be consistent across runs for briefings to be useful.")
//   @why("QA agents with zero context about changes need SOME context about historically-broken areas. QA Memory provides that without revealing what was changed.")
// }
// @end

export interface QAMemoryEntry {
  flow: string;               // e.g., "check node status via API"
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  failureDetails?: string;
  edgeCase?: string;          // what triggered the failure
  timestamp: number;
  changeId?: string;          // governance proposal or commit
}

export interface QAFlowResult {
  flow: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  evidence: string;
  duration?: number;
}

const MAX_ENTRIES = 500;

export class QAMemory {
  private memoryPath: string;
  private entries: QAMemoryEntry[] = [];

  constructor(dataDir: string) {
    const dir = join(dataDir, 'council');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.memoryPath = join(dir, 'qa-memory.json');
    this.load();
  }

  /**
   * Add a QA result entry.
   */
  addEntry(entry: QAMemoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.save();
  }

  /**
   * Get a briefing for a specific flow — historical failures that
   * a QA agent should pay attention to.
   */
  getBriefing(flow: string): string {
    const flowEntries = this.entries.filter(
      e => e.flow.toLowerCase() === flow.toLowerCase()
    );

    if (flowEntries.length === 0) {
      return `No previous QA history for flow: "${flow}". This is the first test.`;
    }

    const failures = flowEntries.filter(e => e.verdict === 'FAIL');
    const passes = flowEntries.filter(e => e.verdict === 'PASS');
    const inconclusive = flowEntries.filter(e => e.verdict === 'INCONCLUSIVE');

    let briefing = `QA History for "${flow}": ${passes.length} PASS, ${failures.length} FAIL, ${inconclusive.length} INCONCLUSIVE\n`;

    if (failures.length > 0) {
      briefing += '\nPrevious failures (pay extra attention to these):\n';
      // Show last 5 failures
      const recentFailures = failures.slice(-5);
      for (const f of recentFailures) {
        const date = new Date(f.timestamp).toISOString().slice(0, 10);
        briefing += `  - [${date}] ${f.failureDetails || 'no details'}`;
        if (f.edgeCase) briefing += ` (edge case: ${f.edgeCase})`;
        briefing += '\n';
      }
    }

    return briefing;
  }

  /**
   * Get all failure patterns — useful for council reflection.
   */
  getFailurePatterns(): QAMemoryEntry[] {
    return this.entries.filter(e => e.verdict === 'FAIL');
  }

  /**
   * Get summary stats.
   */
  getStats(): { total: number; pass: number; fail: number; inconclusive: number } {
    return {
      total: this.entries.length,
      pass: this.entries.filter(e => e.verdict === 'PASS').length,
      fail: this.entries.filter(e => e.verdict === 'FAIL').length,
      inconclusive: this.entries.filter(e => e.verdict === 'INCONCLUSIVE').length,
    };
  }

  /**
   * Get all entries (for API/debugging).
   */
  getEntries(): QAMemoryEntry[] {
    return [...this.entries];
  }

  private load(): void {
    try {
      if (existsSync(this.memoryPath)) {
        const raw = readFileSync(this.memoryPath, 'utf-8');
        this.entries = JSON.parse(raw);
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(this.memoryPath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[qa-memory] Failed to save: ${err.message}`);
    }
  }
}
