/**
 * ContentPublisher — Phase 11: Content Layer
 *
 * Handles the publish flow for content created by agent tasks.
 * After a task completes, if it produced publishable content (website, API, etc.),
 * the publisher extracts output, creates a ContentRecord, and announces it to
 * the network.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContentType, ContentManifest, ContentRecord, ContentStatus } from '@pando/shared';
import type { ContentRegistry } from './content-registry.js';

export interface PublishOptions {
  type: ContentType;
  title: string;
  description?: string;
  repoUrl?: string;
  liveUrl?: string;
  tags?: string[];
  manifest?: Partial<ContentManifest>;
  status?: ContentStatus;
  builderPeerId?: string;
}

/** Summary of files extracted from a workspace. */
export interface ExtractedContent {
  files: { path: string; size: number }[];
  totalSize: number;
  fileCount: number;
  hash: string;
}

export class ContentPublisher {
  private registry: ContentRegistry;
  private localPeerId: string = '';

  constructor(registry: ContentRegistry) {
    this.registry = registry;
  }

  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  /**
   * Extract content from a workspace directory.
   * Collects files, computes a content hash, and returns a summary.
   */
  extractContent(workspacePath: string): ExtractedContent | null {
    if (!existsSync(workspacePath)) {
      console.log(`[content-publish] Workspace not found: ${workspacePath}`);
      return null;
    }

    const files: { path: string; size: number }[] = [];
    const hash = createHash('sha256');
    let totalSize = 0;

    // Walk the workspace, skipping node_modules and hidden dirs
    const walk = (dir: string, prefix: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(fullPath, relPath);
          } else if (entry.isFile()) {
            try {
              const stat = statSync(fullPath);
              files.push({ path: relPath, size: stat.size });
              totalSize += stat.size;
              // Hash first 4KB of each file for content fingerprint
              const content = readFileSync(fullPath, { encoding: null }).subarray(0, 4096);
              hash.update(content);
              hash.update(relPath);
            } catch {}
          }
        }
      } catch {}
    };

    walk(workspacePath, '');

    if (files.length === 0) {
      console.log(`[content-publish] No files found in workspace: ${workspacePath}`);
      return null;
    }

    return {
      files,
      totalSize,
      fileCount: files.length,
      hash: hash.digest('hex').slice(0, 16),
    };
  }

  /**
   * Create a content record from extracted content and metadata.
   * Registers it in the ContentRegistry and broadcasts to the network.
   */
  createContentRecord(options: PublishOptions): ContentRecord {
    const record = this.registry.create({
      type: options.type,
      title: options.title,
      description: options.description,
      ownerPeerId: this.localPeerId || undefined,
      builderPeerId: options.builderPeerId || this.localPeerId || undefined,
      repoUrl: options.repoUrl,
      liveUrl: options.liveUrl,
      tags: options.tags,
      manifest: options.manifest,
      status: options.status || 'draft',
    });

    console.log(`[content-publish] Created content record: ${record.title} (${record.contentId.slice(0, 8)})`);
    return record;
  }

  /**
   * Full publish flow: extract content from workspace, create record, return it.
   */
  publish(workspacePath: string, options: PublishOptions): ContentRecord | null {
    const extracted = this.extractContent(workspacePath);
    if (!extracted) {
      console.log(`[content-publish] Nothing to publish from workspace`);
      return null;
    }

    const record = this.createContentRecord(options);
    console.log(`[content-publish] Published: ${record.title} (${extracted.fileCount} files, ${(extracted.totalSize / 1024).toFixed(1)}KB)`);
    return record;
  }

  /**
   * Update an existing content record (version bump).
   * Used when content is rebuilt or updated.
   */
  updateContent(contentId: string, updates: Partial<{
    title: string;
    description: string;
    repoUrl: string;
    liveUrl: string;
    tags: string[];
    status: ContentStatus;
    manifest: Partial<ContentManifest>;
  }>): ContentRecord | null {
    const updated = this.registry.update(contentId, updates);
    if (updated) {
      console.log(`[content-publish] Updated content: ${updated.title} v${updated.version}`);
    }
    return updated;
  }
}
