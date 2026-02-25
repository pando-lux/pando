/**
 * ContentMaintenance — Phase 11: Content Layer
 *
 * Periodically scans owned content and checks health.
 * If content with auto-maintain policy is unhealthy or stale,
 * creates a maintenance task via the task queue.
 */

import type { ContentRecord } from '@pando/shared';
import type { ContentRegistry } from './content-registry.js';

export interface MaintenanceConfig {
  scanIntervalMs: number;  // default: 1 hour
  healthCheckTimeoutMs: number; // default: 10 seconds
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  scanIntervalMs: 60 * 60 * 1000,  // 1 hour
  healthCheckTimeoutMs: 10_000,     // 10 seconds
};

export type MaintenanceIssue = 'unhealthy' | 'stale' | 'down';

export interface MaintenanceCheck {
  contentId: string;
  title: string;
  issue: MaintenanceIssue;
  detail: string;
  timestamp: number;
}

export class ContentMaintenance {
  private registry: ContentRegistry;
  private localPeerId: string = '';
  private config: MaintenanceConfig;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private taskCreator: ((title: string, description: string, priority: string) => void) | null = null;
  private running = false;

  constructor(registry: ContentRegistry, config?: Partial<MaintenanceConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  /**
   * Set a callback for creating maintenance tasks.
   * The callback receives (title, description, priority).
   */
  setTaskCreator(fn: (title: string, description: string, priority: string) => void): void {
    this.taskCreator = fn;
  }

  /** Start the periodic maintenance scan. */
  startMaintenanceLoop(): void {
    if (this.running) return;
    this.running = true;

    // Do an initial scan after 5 minutes (let the node settle)
    setTimeout(() => {
      if (this.running) this.scan().catch(() => {});
    }, 5 * 60 * 1000);

    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => {
        console.error(`[content-maintenance] Scan error: ${err.message}`);
      });
    }, this.config.scanIntervalMs);

    console.log(`[content-maintenance] Started (interval: ${Math.round(this.config.scanIntervalMs / 60000)}min)`);
  }

  /** Stop the maintenance loop. */
  stop(): void {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    console.log('[content-maintenance] Stopped');
  }

  /** Run a maintenance scan across all owned content. */
  async scan(): Promise<MaintenanceCheck[]> {
    if (!this.localPeerId) return [];

    // Get content where this node is a hosting node
    const allContent = this.registry.list({ status: 'live' });
    const ownedContent = allContent.filter(c =>
      c.hostingNodes.includes(this.localPeerId) ||
      c.ownerPeerId === this.localPeerId
    );

    if (ownedContent.length === 0) return [];

    const issues: MaintenanceCheck[] = [];

    for (const content of ownedContent) {
      // Only check content with auto-maintain policy
      if (content.manifest.upgradePolicy !== 'auto-maintain') continue;

      // Check if liveUrl is responding
      if (content.liveUrl) {
        const healthy = await this.checkContentHealth(content);
        if (!healthy) {
          const check: MaintenanceCheck = {
            contentId: content.contentId,
            title: content.title,
            issue: 'unhealthy',
            detail: `Live URL ${content.liveUrl} is not responding`,
            timestamp: Date.now(),
          };
          issues.push(check);
          this.createMaintenanceTask(content, check);
        }
      }

      // Check staleness based on updateSchedule
      if (content.manifest.updateSchedule) {
        const stale = this.isStale(content);
        if (stale) {
          const check: MaintenanceCheck = {
            contentId: content.contentId,
            title: content.title,
            issue: 'stale',
            detail: `Content has not been updated since ${new Date(content.updatedAt).toISOString()}`,
            timestamp: Date.now(),
          };
          issues.push(check);
          this.createMaintenanceTask(content, check);
        }
      }
    }

    if (issues.length > 0) {
      console.log(`[content-maintenance] Found ${issues.length} issue(s) in ${ownedContent.length} content items`);
    }

    return issues;
  }

  /** Check if a content item's live URL is responding. */
  private async checkContentHealth(content: ContentRecord): Promise<boolean> {
    if (!content.liveUrl) return true;
    try {
      const res = await fetch(content.liveUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(this.config.healthCheckTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Check if content is stale based on its update schedule. */
  private isStale(content: ContentRecord): boolean {
    if (!content.manifest.updateSchedule) return false;

    // Simple schedule parsing: "daily", "weekly", "monthly", or number of hours
    const schedule = content.manifest.updateSchedule.toLowerCase();
    let maxAgeMs: number;

    if (schedule === 'daily') maxAgeMs = 24 * 60 * 60 * 1000;
    else if (schedule === 'weekly') maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    else if (schedule === 'monthly') maxAgeMs = 30 * 24 * 60 * 60 * 1000;
    else {
      const hours = parseInt(schedule, 10);
      if (isNaN(hours) || hours <= 0) return false;
      maxAgeMs = hours * 60 * 60 * 1000;
    }

    const age = Date.now() - content.updatedAt;
    return age > maxAgeMs;
  }

  /** Create a maintenance task for unhealthy or stale content. */
  private createMaintenanceTask(content: ContentRecord, check: MaintenanceCheck): void {
    if (!this.taskCreator) {
      console.log(`[content-maintenance] No task creator set — cannot create maintenance task for ${content.title}`);
      return;
    }

    const title = `Maintenance: ${content.title} (${check.issue})`;
    const description = [
      `Content maintenance task auto-generated by ContentMaintenance.`,
      ``,
      `Content: ${content.title} (${content.contentId})`,
      `Type: ${content.type}`,
      `Issue: ${check.issue}`,
      `Detail: ${check.detail}`,
      content.liveUrl ? `Live URL: ${content.liveUrl}` : '',
      content.repoUrl ? `Repo URL: ${content.repoUrl}` : '',
      ``,
      `Action needed: Investigate and fix the issue. Update the content record when resolved.`,
    ].filter(Boolean).join('\n');

    const priority = check.issue === 'unhealthy' ? 'high' : 'medium';

    try {
      this.taskCreator(title, description, priority);
      console.log(`[content-maintenance] Created task: ${title}`);
    } catch (err: any) {
      console.error(`[content-maintenance] Failed to create task: ${err.message}`);
    }
  }
}
