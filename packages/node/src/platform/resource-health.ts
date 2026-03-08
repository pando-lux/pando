/**
 * Phase 53.8: Resource Health Checker
 *
 * Runs periodic health checks on contributed resources (MongoDB ping, S3 HEAD,
 * GitHub API, OpenAI models, etc.). Results stored in memory and exposed via
 * GET /v1/resources/health. Only runs on nodes with CredentialStore access
 * (trusted compute nodes).
 */

import type { CredentialStore } from '../core/credential-store.js';
import type { ResourceRegistry } from './resource-registry.js';

export interface HealthResult {
  resourceId: string;
  type: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unchecked';
  latencyMs?: number;
  checkedAt?: number;
  error?: string;
}

export class ResourceHealthChecker {
  private results: Map<string, HealthResult> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private credentialStore: CredentialStore | null = null;
  private resourceRegistry: ResourceRegistry | null = null;
  private running = false;

  setDependencies(credentialStore: CredentialStore, resourceRegistry: ResourceRegistry): void {
    this.credentialStore = credentialStore;
    this.resourceRegistry = resourceRegistry;
  }

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.running || !this.credentialStore) return;
    this.running = true;
    // Run immediately, then on interval
    this.checkAll().catch(() => {});
    this.interval = setInterval(() => {
      this.checkAll().catch(() => {});
    }, intervalMs);
    console.log('[health-checker] Started (interval: 5m)');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.running = false;
  }

  getResults(): HealthResult[] {
    return Array.from(this.results.values());
  }

  getResult(resourceId: string): HealthResult | undefined {
    return this.results.get(resourceId);
  }

  async checkAll(): Promise<void> {
    if (!this.credentialStore || !this.resourceRegistry) return;

    const resources = this.resourceRegistry.getAllResources();
    for (const resource of resources) {
      if (resource.status !== 'active') continue;
      try {
        const result = await this.checkOne(resource.resourceId, resource.type);
        this.results.set(resource.resourceId, result);
        // #3: Feed health check results back into credential selection
        if (this.credentialStore) {
          this.credentialStore.markHealthStatus(resource.resourceId, result.status === 'healthy');
        }
      } catch (err: any) {
        this.results.set(resource.resourceId, {
          resourceId: resource.resourceId,
          type: resource.type,
          status: 'unhealthy',
          checkedAt: Date.now(),
          error: err.message?.slice(0, 120) || 'Unknown error',
        });
        // #3: Mark as unhealthy on error
        if (this.credentialStore) {
          this.credentialStore.markHealthStatus(resource.resourceId, false);
        }
      }
    }
  }

  private async checkOne(resourceId: string, type: string): Promise<HealthResult> {
    if (!this.credentialStore) {
      return { resourceId, type, status: 'unchecked' };
    }

    const t0 = Date.now();
    let status: HealthResult['status'] = 'unhealthy';
    let error: string | undefined;

    try {
      const credential = await this.credentialStore.getCredential(resourceId);
      if (!credential) {
        return { resourceId, type, status: 'unchecked', checkedAt: Date.now(), error: 'Credential not found' };
      }

      switch (type) {
        case 'ai_api_key':
          await this.checkAiApiKey(credential);
          break;
        case 'storage_db':
          await this.checkMongoDb(credential);
          break;
        case 'storage_blob':
          await this.checkS3(credential);
          break;
        case 'code_repository':
          await this.checkGitHub(credential);
          break;
        case 'cloud_compute':
          await this.checkAws(credential);
          break;
        case 'hosting_platform':
          await this.checkHostingPlatform(credential);
          break;
        default:
          return { resourceId, type, status: 'unchecked', checkedAt: Date.now() };
      }
      status = 'healthy';
    } catch (err: any) {
      error = err.message?.slice(0, 120) || 'Check failed';
      // Distinguish degraded (slow/partial) from unhealthy (outright failure)
      status = 'unhealthy';
    }

    return { resourceId, type, status, latencyMs: Date.now() - t0, checkedAt: Date.now(), error };
  }

  /** OpenAI / Anthropic / Gemini — hit their models list or token check endpoint */
  private async checkAiApiKey(credential: string): Promise<void> {
    // Auto-detect provider from key prefix
    let url: string;
    let headers: Record<string, string>;

    if (credential.startsWith('sk-ant-')) {
      // Anthropic
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
    } else if (credential.startsWith('AIza')) {
      // Google Gemini — use generativelanguage models list
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential)}`;
      headers = {};
    } else {
      // OpenAI (or compatible)
      url = 'https://api.openai.com/v1/models';
      headers = { 'Authorization': `Bearer ${credential}` };
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /** MongoDB — connect and ping */
  private async checkMongoDb(connectionString: string): Promise<void> {
    // Dynamic import to avoid loading mongoose at startup
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 6000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
    } finally {
      await client.close();
    }
  }

  /** S3 — list buckets (minimal permission check) */
  private async checkS3(credential: string): Promise<void> {
    // credential format: "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:BUCKET_NAME]"
    const parts = credential.split(':');
    if (parts.length < 2) throw new Error('Invalid S3 credential format');
    const [accessKeyId, secretAccessKey] = parts;

    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: 8000 } as any,
    });
    try {
      await client.send(new ListBucketsCommand({}));
    } finally {
      client.destroy();
    }
  }

  /** GitHub PAT — check rate limit (always allowed, confirms key is valid) */
  private async checkGitHub(pat: string): Promise<void> {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Pando-Node/1.0',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /** AWS — describe regions (minimal, works with any valid credentials) */
  /** Hosting platform token health check — verify token is valid with provider API */
  private async checkHostingPlatform(credential: string): Promise<void> {
    // Try Vercel API first (most common). If it fails, assume other provider — just check non-empty.
    try {
      const res = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return; // Vercel token valid
      // If 401/403, might be a different provider's token — that's ok, just check non-empty
      if (res.status === 401 || res.status === 403) {
        // Check if it's a Netlify token
        const netlifyRes = await fetch('https://api.netlify.com/api/v1/user', {
          headers: { Authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(8000),
        });
        if (netlifyRes.ok) return;
      }
      throw new Error(`Hosting token verification failed (HTTP ${res.status})`);
    } catch (err: any) {
      if (err.message?.includes('Hosting token')) throw err;
      throw new Error(`Hosting token check failed: ${err.message}`);
    }
  }

  private async checkAws(credential: string): Promise<void> {
    const parts = credential.split(':');
    if (parts.length < 2) throw new Error('Invalid AWS credential format');
    const [accessKeyId, secretAccessKey] = parts;

    const { EC2Client, DescribeRegionsCommand } = await import('@aws-sdk/client-ec2');
    const client = new EC2Client({
      region: 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: 8000 } as any,
    });
    try {
      await client.send(new DescribeRegionsCommand({ Filters: [{ Name: 'opt-in-status', Values: ['opt-in-not-required'] }] }));
    } finally {
      client.destroy();
    }
  }
}
