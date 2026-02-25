/**
 * HostingService — Phase 32: S3 Hosting
 *
 * Manages project deployments to S3. Public projects are served directly
 * via the S3 static website endpoint. Private/shared projects use
 * pre-signed URLs with a 1-hour TTL.
 *
 * Bucket layout:
 *   s3://pando-deployments/public/<projectId>/   — publicly readable
 *   s3://pando-deployments/private/<projectId>/  — pre-signed access only
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DeploymentInfo, ProjectType } from '@pando/shared';

const BUCKET = process.env.PANDO_S3_BUCKET || 'pando-deployments';
const REGION = process.env.PANDO_S3_REGION || 'us-east-1';
const WEBSITE_BASE = `http://${BUCKET}.s3-website-${REGION}.amazonaws.com`;
const PRESIGN_TTL = 3600; // 1 hour

export interface DeployFile {
  path: string;         // relative path within the project (e.g. "index.html")
  content: Buffer;
  contentType: string;  // MIME type (e.g. "text/html")
}

interface StorageRecord {
  projectId: string;
  projectType: ProjectType;
  fileCount: number;
  totalSize: number;
  deployedAt: number;
}

export class HostingService {
  private s3: S3Client;
  /** In-memory deployment tracking. */
  private deployments = new Map<string, StorageRecord>();

  constructor() {
    // AWS SDK picks up credentials from ~/.aws/credentials automatically.
    this.s3 = new S3Client({ region: REGION });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Return the S3 key prefix for a given project. */
  private prefix(projectId: string, projectType: ProjectType): string {
    const bucket = projectType === 'public' ? 'public' : 'private';
    return `${bucket}/${projectId}/`;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Upload all files for a project to S3.
   * Replaces any existing deployment (does NOT delete old files — call
   * removeDeployment first for a clean slate if needed).
   */
  async deployProject(
    projectId: string,
    projectType: ProjectType,
    files: DeployFile[],
  ): Promise<DeploymentInfo> {
    const pfx = this.prefix(projectId, projectType);
    let totalSize = 0;

    for (const file of files) {
      const key = `${pfx}${file.path}`;
      await this.s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.content,
        ContentType: file.contentType,
      }));
      totalSize += file.content.length;
    }

    const record: StorageRecord = {
      projectId,
      projectType,
      fileCount: files.length,
      totalSize,
      deployedAt: Date.now(),
    };
    this.deployments.set(projectId, record);

    console.log(`[hosting] Deployed ${files.length} files for project ${projectId} (${totalSize} bytes, type=${projectType})`);

    return this.buildDeploymentInfo(record);
  }

  /**
   * Get the hosted URL for a project.
   * Public projects get a direct S3 website URL.
   * Private/shared projects get a pre-signed URL to index.html (1hr TTL).
   */
  async getHostedUrl(projectId: string, projectType: ProjectType, entryFile: string = 'index.html'): Promise<string> {
    if (projectType === 'public') {
      // Phase 70: Return actual S3 website endpoint — gateway has no /apps/ route
      return `${WEBSITE_BASE}/public/${projectId}/${entryFile}`;
    }

    // Generate a pre-signed URL for private/shared projects
    const key = `private/${projectId}/${entryFile}`;
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: PRESIGN_TTL });
  }

  /**
   * Delete all S3 objects under a project's prefix.
   */
  async removeDeployment(projectId: string): Promise<void> {
    // We don't know the project type from just the ID — check both prefixes.
    for (const bucket of ['public', 'private']) {
      const pfx = `${bucket}/${projectId}/`;
      await this.deletePrefix(pfx);
    }

    this.deployments.delete(projectId);
    console.log(`[hosting] Removed deployment for project ${projectId}`);
  }

  /**
   * Get deployment metadata for a project.
   * Returns a not-deployed stub if no record exists in-memory.
   */
  async getDeploymentInfo(projectId: string): Promise<DeploymentInfo> {
    const record = this.deployments.get(projectId);
    if (record) {
      return this.buildDeploymentInfo(record);
    }

    // No local record — probe S3 to see if anything exists
    for (const bucket of ['public', 'private'] as const) {
      const pfx = `${bucket}/${projectId}/`;
      const resp = await this.s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: pfx,
        MaxKeys: 1,
      }));
      if (resp.Contents && resp.Contents.length > 0) {
        // Files exist but we have no local record — do a full count
        return this.probeDeployment(projectId, bucket === 'public' ? 'public' : 'private');
      }
    }

    return {
      deployed: false,
      projectId,
      projectType: 'private',
      url: '',
      fileCount: 0,
      totalSize: 0,
      deployedAt: 0,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private buildDeploymentInfo(record: StorageRecord): DeploymentInfo {
    const bucket = record.projectType === 'public' ? 'public' : 'private';
    const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL;
    const url = gatewayUrl
      ? `${gatewayUrl}/apps/${record.projectId}/index.html`
      : `${WEBSITE_BASE}/${bucket}/${record.projectId}/index.html`;
    return {
      deployed: true,
      projectId: record.projectId,
      projectType: record.projectType,
      url,
      fileCount: record.fileCount,
      totalSize: record.totalSize,
      deployedAt: record.deployedAt,
    };
  }

  /**
   * Probe S3 for a project's deployment (when we have no local record).
   */
  private async probeDeployment(projectId: string, projectType: ProjectType): Promise<DeploymentInfo> {
    const pfx = this.prefix(projectId, projectType);
    let fileCount = 0;
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const resp = await this.s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: pfx,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents || []) {
        fileCount++;
        totalSize += obj.Size || 0;
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    const record: StorageRecord = {
      projectId,
      projectType,
      fileCount,
      totalSize,
      deployedAt: Date.now(), // best approximation
    };
    this.deployments.set(projectId, record);

    return this.buildDeploymentInfo(record);
  }

  /**
   * Delete all objects under a given S3 prefix.
   */
  private async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listResp = await this.s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const objects: ObjectIdentifier[] = (listResp.Contents || [])
        .filter((o) => o.Key)
        .map((o) => ({ Key: o.Key! }));

      if (objects.length > 0) {
        await this.s3.send(new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objects },
        }));
      }

      continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
