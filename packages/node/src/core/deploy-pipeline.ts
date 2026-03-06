/**
 * Deploy Pipeline — Sequences build completion through to live deployment.
 *
 * Flow: build complete → GitHub push → find secure node → P2P deploy → update metadata
 *
 * This is the glue module. It doesn't implement any of the steps — it calls
 * existing infrastructure in the correct order with error handling.
 *
 * See BIBLE.md Section 5.8 for architecture.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployPipelineConfig {
  /** Local API port (for calling GitHub endpoints) */
  apiPort: number;
  /** API auth token (from ~/.pando/api-token) */
  apiToken?: string;
  /** Project store instance */
  projectStore: ProjectStoreLike;
  /** RequestReply for P2P deploy to secure nodes */
  requestReply: RequestReplyLike;
  /** Capability registry for finding secure/compute nodes */
  capabilityRegistry?: CapabilityRegistryLike;
  /** Local peerId */
  localPeerId: string;
  /** SSE event pusher */
  pushEvent?: (type: string, data: any) => void;
}

export interface PipelineResult {
  success: boolean;
  projectId: string;
  steps: PipelineStep[];
  deploymentUrl?: string;
  repoUrl?: string;
  error?: string;
}

export interface PipelineStep {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  detail?: string;
}

// Minimal interfaces so we don't import from platform/ (layer boundary)
interface ProjectStoreLike {
  getProject(id: string): any | null;
  updateProject(id: string, updates: Record<string, any>): Promise<any>;
}

interface RequestReplyLike {
  request(peerId: string, protocol: string, payload: any, timeoutMs?: number): Promise<any>;
  getHandler?(protocol: string): any;
}

interface CapabilityRegistryLike {
  getAllProfiles(): any[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class DeployPipeline {
  private config: DeployPipelineConfig;

  constructor(config: DeployPipelineConfig) {
    this.config = config;
  }

  /**
   * Run the full deploy pipeline for a project after build completes.
   *
   * Steps:
   * 1. GitHub push (create repo if needed, push workspace)
   * 2. Find a secure/compute node for deployment
   * 3. P2P deploy (clone from GitHub on secure node)
   * 4. Update project metadata (deploymentUrl, status, etc.)
   */
  async run(projectId: string, opts?: { skipGithub?: boolean; skipDeploy?: boolean }): Promise<PipelineResult> {
    const steps: PipelineStep[] = [];
    const project = this.config.projectStore.getProject(projectId);

    if (!project) {
      return { success: false, projectId, steps, error: 'Project not found' };
    }

    this.emit('deploy_pipeline_started', { projectId, projectName: project.name });

    let repoUrl: string | undefined = project.repoUrl;
    let deploymentUrl: string | undefined = project.deploymentUrl;

    // ── Step 1: GitHub Push ──────────────────────────────────────────────
    if (!opts?.skipGithub) {
      const step = await this.stepGithubPush(projectId, project);
      steps.push(step);

      if (step.status === 'success' && step.detail) {
        repoUrl = step.detail;
      } else if (step.status === 'failed') {
        this.emit('deploy_pipeline_failed', { projectId, step: 'github', error: step.detail });
        return { success: false, projectId, steps, repoUrl, error: `GitHub push failed: ${step.detail}` };
      }
    }

    // ── Step 2: Find Secure Node ─────────────────────────────────────────
    let targetPeerId: string | undefined;
    let isLocal = false;

    if (!opts?.skipDeploy) {
      const step = this.stepFindDeployTarget();
      steps.push(step);

      if (step.status === 'success' && step.detail) {
        const parsed = JSON.parse(step.detail);
        targetPeerId = parsed.peerId;
        isLocal = parsed.isLocal;
      } else if (step.status === 'failed') {
        // No deploy target — not fatal, project is on GitHub
        console.warn(`[deploy-pipeline] No deploy target found — project ${projectId} is on GitHub only`);
      }
    }

    // ── Step 3: P2P Deploy ───────────────────────────────────────────────
    if (targetPeerId && repoUrl && !opts?.skipDeploy) {
      const step = await this.stepP2PDeploy(projectId, repoUrl, targetPeerId, isLocal);
      steps.push(step);

      if (step.status === 'success' && step.detail) {
        deploymentUrl = step.detail;
      }
      // Deploy failure is non-fatal — project is still on GitHub
    }

    // ── Step 4: Update Project Metadata ──────────────────────────────────
    const metaStep = await this.stepUpdateMetadata(projectId, {
      repoUrl,
      deploymentUrl,
      deployPeerId: targetPeerId,
      deployed: !!deploymentUrl,
    });
    steps.push(metaStep);

    const allSucceeded = steps.every(s => s.status !== 'failed');
    this.emit('deploy_pipeline_completed', {
      projectId,
      success: allSucceeded,
      repoUrl,
      deploymentUrl,
      steps: steps.map(s => ({ name: s.name, status: s.status })),
    });

    return {
      success: allSucceeded,
      projectId,
      steps,
      repoUrl,
      deploymentUrl,
    };
  }

  // ── Individual Steps ─────────────────────────────────────────────────────

  private async stepGithubPush(projectId: string, project: any): Promise<PipelineStep> {
    const start = Date.now();
    const name = 'github_push';

    try {
      const port = this.config.apiPort;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiToken) {
        headers['Authorization'] = `Bearer ${this.config.apiToken}`;
      }

      // Push workspace to GitHub (this endpoint creates repo if needed)
      const pushUrl = `http://127.0.0.1:${port}/v1/projects/${projectId}/github/push`;
      const workspaceDir = project.workspaceDir || '';

      const resp = await fetch(pushUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceDir }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { name, status: 'failed', durationMs: Date.now() - start, detail: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }

      const data = await resp.json() as any;
      const repoUrl = data.repoUrl || '';
      console.log(`[deploy-pipeline] GitHub push succeeded: ${repoUrl}`);

      return { name, status: 'success', durationMs: Date.now() - start, detail: repoUrl };
    } catch (err: any) {
      return { name, status: 'failed', durationMs: Date.now() - start, detail: err.message?.slice(0, 200) };
    }
  }

  private stepFindDeployTarget(): PipelineStep {
    const start = Date.now();
    const name = 'find_deploy_target';

    const registry = this.config.capabilityRegistry;
    if (!registry) {
      return { name, status: 'failed', durationMs: Date.now() - start, detail: 'No capability registry' };
    }

    const profiles = registry.getAllProfiles();

    // Deploy targets are EC2 SECURE nodes — they have credentialAccess (CREDENTIAL_MASTER_KEY)
    // and direct MongoDB. They can decrypt S3 creds for Tier 1 and run PM2/nginx for Tier 2.
    // This is NOT the same as PandoCode contributor nodes (shareCompute + compute_cpu) which BUILD.
    // BIBLE Section 5.8: "PandoCode builds. Secure nodes deploy. Keys never travel."
    const candidates = profiles.filter((p: any) =>
      p.credentialAccess === true &&
      p.storageBackend === 'mongodb' &&
      p.peerId !== this.config.localPeerId
    );

    if (candidates.length > 0) {
      const target = candidates[0];
      console.log(`[deploy-pipeline] Deploy target: ${target.peerId.slice(0, 8)} (EC2 secure node)`);
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: JSON.stringify({ peerId: target.peerId, isLocal: false }),
      };
    }

    // Fallback: self-deploy only if THIS node is a secure node (has credential decryption)
    const selfProfile = profiles.find((p: any) => p.peerId === this.config.localPeerId);
    if (selfProfile?.credentialAccess === true) {
      console.log(`[deploy-pipeline] Deploy target: self (local secure node)`);
      return {
        name,
        status: 'success',
        durationMs: Date.now() - start,
        detail: JSON.stringify({ peerId: this.config.localPeerId, isLocal: true }),
      };
    }

    return { name, status: 'failed', durationMs: Date.now() - start, detail: 'No secure nodes with credentialAccess available' };
  }

  private async stepP2PDeploy(
    projectId: string,
    repoUrl: string,
    targetPeerId: string,
    isLocal: boolean,
  ): Promise<PipelineStep> {
    const start = Date.now();
    const name = 'p2p_deploy';

    const deployPayload = {
      projectId,
      repoUrl: repoUrl.endsWith('.git') ? repoUrl : `${repoUrl}.git`,
      tier: 1, // auto-detect on the receiving end
    };

    try {
      let response: any;

      if (isLocal) {
        // Self-deploy: invoke handler directly
        const handler = this.config.requestReply.getHandler?.('pando/deploy-app');
        if (handler) {
          const result = await handler({ payload: deployPayload });
          response = { success: true, payload: result };
        } else {
          return { name, status: 'failed', durationMs: Date.now() - start, detail: 'Local deploy handler not registered' };
        }
      } else {
        // Remote deploy via P2P
        response = await this.config.requestReply.request(
          targetPeerId, 'pando/deploy-app', deployPayload, 300_000
        );
      }

      if (response?.success && response.payload) {
        const payload = response.payload;
        if (payload.status === 'failed') {
          return { name, status: 'failed', durationMs: Date.now() - start, detail: payload.error || 'Deploy returned failed status' };
        }

        // Construct the best URL based on deploy type:
        // Tier 1 (S3): use s3Url or url (already a public URL)
        // Tier 2 (PM2): use publicAddress + nginx path (not localhost)
        let url = '';
        if (payload.s3Url) {
          url = payload.s3Url;
        } else if (payload.publicAddress && payload.port) {
          // Tier 2: prefer nginx route if available, otherwise direct port
          url = `http://${payload.publicAddress}/apps/${projectId}/`;
        } else if (payload.url && !payload.url.includes('localhost')) {
          url = payload.url;
        } else if (payload.publicAddress) {
          url = `http://${payload.publicAddress}/`;
        } else {
          url = payload.url || '';
        }
        console.log(`[deploy-pipeline] Deployed to ${isLocal ? 'local' : targetPeerId.slice(0, 8)}: ${url}`);
        return { name, status: 'success', durationMs: Date.now() - start, detail: url };
      }

      return { name, status: 'failed', durationMs: Date.now() - start, detail: 'No response from deploy target' };
    } catch (err: any) {
      return { name, status: 'failed', durationMs: Date.now() - start, detail: err.message?.slice(0, 200) };
    }
  }

  private async stepUpdateMetadata(
    projectId: string,
    data: { repoUrl?: string; deploymentUrl?: string; deployPeerId?: string; deployed: boolean },
  ): Promise<PipelineStep> {
    const start = Date.now();
    const name = 'update_metadata';

    try {
      const updates: Record<string, any> = {
        updatedAt: Date.now(),
      };

      if (data.repoUrl) updates.repoUrl = data.repoUrl;
      if (data.deploymentUrl) {
        updates.deploymentUrl = data.deploymentUrl;
        updates.deploymentStatus = 'live';
      }
      if (data.deployPeerId) updates.deployPeerId = data.deployPeerId;
      if (data.deployed) updates.deploymentStatus = 'live';

      await this.config.projectStore.updateProject(projectId, updates);
      console.log(`[deploy-pipeline] Project ${projectId} metadata updated`);

      return { name, status: 'success', durationMs: Date.now() - start };
    } catch (err: any) {
      return { name, status: 'failed', durationMs: Date.now() - start, detail: err.message?.slice(0, 200) };
    }
  }

  private emit(type: string, data: any): void {
    if (this.config.pushEvent) {
      try { this.config.pushEvent(type, data); } catch { /* best-effort */ }
    }
  }
}
