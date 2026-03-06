/**
 * Findings Store — Communication channel between Observer/QA and Council.
 *
 * Observer and QA create findings. Council reads and resolves them.
 * In-memory Map with simple CRUD. No SQLite needed — findings are
 * ephemeral (current session only). Board + Memory handle persistence.
 *
 * See BIBLE.md Section 5.10.3 for schema and API design.
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingSeverity = 'info' | 'warning' | 'critical';
export type FindingCategory = 'health' | 'test_failure' | 'security' | 'performance' | 'suggestion';
export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';
export type FindingSource = 'observer' | 'qa' | 'council' | 'user';

export interface Finding {
  id: string;
  source: FindingSource;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  target?: string;
  status: FindingStatus;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  actionTaken?: string;
}

export interface CreateFindingInput {
  source: FindingSource;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  target?: string;
}

export interface UpdateFindingInput {
  status?: FindingStatus;
  resolvedBy?: string;
  actionTaken?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// Singleton — shared across API routes and engine adapter
let _instance: FindingsStore | null = null;
export function getFindingsStore(): FindingsStore {
  if (!_instance) _instance = new FindingsStore();
  return _instance;
}

export class FindingsStore {
  private findings = new Map<string, Finding>();

  create(input: CreateFindingInput): Finding {
    const id = randomBytes(8).toString('hex');
    const finding: Finding = {
      id,
      source: input.source,
      severity: input.severity,
      category: input.category,
      title: input.title,
      detail: input.detail,
      target: input.target,
      status: 'open',
      createdAt: Date.now(),
    };
    this.findings.set(id, finding);
    return finding;
  }

  get(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  update(id: string, input: UpdateFindingInput): Finding | undefined {
    const finding = this.findings.get(id);
    if (!finding) return undefined;

    if (input.status) finding.status = input.status;
    if (input.resolvedBy) finding.resolvedBy = input.resolvedBy;
    if (input.actionTaken) finding.actionTaken = input.actionTaken;
    if (input.status === 'resolved' || input.status === 'wont_fix') {
      finding.resolvedAt = Date.now();
    }

    return finding;
  }

  list(filters?: { status?: FindingStatus; severity?: FindingSeverity; source?: FindingSource }): Finding[] {
    let results = Array.from(this.findings.values());
    if (filters?.status) results = results.filter(f => f.status === filters.status);
    if (filters?.severity) results = results.filter(f => f.severity === filters.severity);
    if (filters?.source) results = results.filter(f => f.source === filters.source);
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  summary(): { total: number; open: number; inProgress: number; resolved: number; bySeverity: Record<string, number> } {
    const all = Array.from(this.findings.values());
    return {
      total: all.length,
      open: all.filter(f => f.status === 'open').length,
      inProgress: all.filter(f => f.status === 'in_progress').length,
      resolved: all.filter(f => f.status === 'resolved' || f.status === 'wont_fix').length,
      bySeverity: {
        critical: all.filter(f => f.severity === 'critical' && f.status === 'open').length,
        warning: all.filter(f => f.severity === 'warning' && f.status === 'open').length,
        info: all.filter(f => f.severity === 'info' && f.status === 'open').length,
      },
    };
  }
}
