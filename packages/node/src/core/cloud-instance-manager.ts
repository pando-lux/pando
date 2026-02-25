/**
 * Phase 64: CloudInstanceManager — Launch and manage secure EC2 compute instances.
 *
 * Operators contribute AWS credentials, Pando launches locked-down EC2 instances:
 * - No SSH (sshd removed), no SSM, no Instance Connect
 * - Tripwire monitoring (wipe & shutdown on any login detection)
 * - Runs a Pando node in 'compute' mode (P2P + hosting, no agents)
 * - All management via P2P (no shell access needed)
 * - App deployment via P2P request-reply (compute node pulls from GitHub/S3)
 *
 * The operator can only terminate instances — never log in.
 */

import type { PandoNode } from '../index.js';
import type { CloudInstanceRecord, NodeMode } from '@pando/shared';
import type Database from 'better-sqlite3';

// Ubuntu 24.04 LTS AMIs by region (HVM, SSD, amd64)
// These are Canonical's official AMI IDs — update periodically.
const UBUNTU_AMIS: Record<string, string> = {
  'us-east-1': 'ami-0f9de6e2d2f067fca',
  'us-east-2': 'ami-0ea3405d2d2522162',
  'us-west-1': 'ami-0da424eb883458071',
  'us-west-2': 'ami-0cf2b4e024cdb6960',
  'eu-west-1': 'ami-0607a9783dd204cae',
  'eu-central-1': 'ami-0faab6bdbac9486fb',
  'ap-southeast-1': 'ami-060e277c0d4cce553',
  'ap-northeast-1': 'ami-0a0b7b240264a48d7',
};

const DEFAULT_INSTANCE_TYPE = 't3.small';
const DEFAULT_REGION = 'us-east-1';
const SECURITY_GROUP_NAME = 'pando-compute-node';
const PUBLIC_REPO = 'https://github.com/pando-lux/pando.git';
const PANDO_TAG_KEY = 'pando';
const PANDO_TAG_VALUE = 'compute-node';

export class CloudInstanceManager {
  private node: PandoNode;
  private db: Database.Database | null = null;
  private instances: Map<string, CloudInstanceRecord> = new Map();

  constructor(node: PandoNode) {
    this.node = node;
  }

  /**
   * Initialize — create SQLite table for instance tracking, load existing records.
   */
  async init(): Promise<void> {
    const ledger = this.node.getLedger();
    if (!ledger) throw new Error('Ledger not initialized');

    this.db = ledger.getDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_instances (
        instance_id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        region TEXT NOT NULL,
        instance_type TEXT NOT NULL,
        public_ip TEXT,
        peer_id TEXT,
        status TEXT NOT NULL DEFAULT 'launching',
        launched_at INTEGER NOT NULL,
        terminated_at INTEGER,
        mode TEXT NOT NULL DEFAULT 'compute',
        apps TEXT NOT NULL DEFAULT '[]',
        error TEXT
      )
    `);

    this.loadInstances();

    // Auto-link compute instances by IP when they connect to P2P
    const network = this.node.getNetwork();
    if (network) {
      network.onPeerConnect((peerId: string) => {
        // Delay to allow connection info to settle
        setTimeout(() => this.tryLinkByIp(peerId), 10_000);
      });
    }

    console.log(`[cloud] CloudInstanceManager initialized. ${this.instances.size} tracked instances.`);
  }

  /**
   * Phase 69: Auto-link compute instances by IP when they join the P2P network.
   * In Phase 69, EC2 instances get credential access via CREDENTIAL_MASTER_KEY env var
   * (injected in user-data at launch). No per-node key wrapping needed.
   */
  private tryLinkByIp(peerId: string): void {
    // Check if already linked to any instance
    for (const inst of this.instances.values()) {
      if (inst.peerId === peerId) return; // already linked
    }

    // Match by IP — check if this peer's address matches any instance's public IP
    const network = this.node.getNetwork();
    if (!network) return;
    try {
      const libp2p = (network as any).node;
      const connections = libp2p?.getConnections?.() || [];
      for (const conn of connections) {
        if (conn.remotePeer?.toString() === peerId) {
          const addr = conn.remoteAddr?.toString() || '';
          const ipMatch = addr.match(/\/ip4\/([\d.]+)\//);
          if (ipMatch) {
            const peerIp = ipMatch[1];
            for (const inst of this.instances.values()) {
              if (inst.publicIp === peerIp && inst.status !== 'terminated') {
                this.linkPeer(inst.instanceId, peerId);
                console.log(`[cloud] Auto-linked instance ${inst.instanceId} to peer ${peerId.slice(0, 16)}... by IP`);
                return;
              }
            }
          }
          break;
        }
      }
    } catch { /* IP matching is best-effort */ }
  }

  /**
   * Launch a secure EC2 instance from contributed AWS credentials.
   */
  async launchInstance(resourceId: string, options?: {
    instanceType?: string;
    region?: string;
  }): Promise<CloudInstanceRecord> {
    const registry = this.node.getResourceRegistry();
    if (!registry) throw new Error('ResourceRegistry not available');

    // 1. Decrypt AWS credentials
    const credentialJson = await registry.getCredential(resourceId);
    if (!credentialJson) throw new Error(`Cannot decrypt AWS credentials for resource ${resourceId}`);

    let creds: { accessKeyId: string; secretAccessKey: string };
    try {
      creds = JSON.parse(credentialJson);
    } catch {
      throw new Error('AWS credential is not valid JSON. Expected { accessKeyId, secretAccessKey }');
    }

    if (!creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error('AWS credential missing accessKeyId or secretAccessKey');
    }

    const region = options?.region || DEFAULT_REGION;
    const instanceType = options?.instanceType || DEFAULT_INSTANCE_TYPE;
    const amiId = UBUNTU_AMIS[region];
    if (!amiId) throw new Error(`No Ubuntu AMI configured for region ${region}. Supported: ${Object.keys(UBUNTU_AMIS).join(', ')}`);

    // 2. Import AWS SDK dynamically (only needed when launching)
    const { EC2Client, RunInstancesCommand, DescribeInstancesCommand,
            CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand,
            DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2');

    const ec2 = new EC2Client({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });

    // 3. Ensure security group exists (throws on failure — never launch without it)
    const sgId = await this.ensureSecurityGroup(ec2, region, {
      CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand,
      DescribeSecurityGroupsCommand,
    });

    // 4. Generate user-data bootstrap script
    const network = this.node.getNetwork();
    const bootstrapPeers = network ? network.getPeers().map(p => {
      return p.addresses.length > 0 ? p.addresses[0] : null;
    }).filter(Boolean).slice(0, 3) : [];

    const userData = this.generateUserData({
      bootstrapPeers: bootstrapPeers as string[],
      mode: 'compute' as NodeMode,
      apiPort: 4000,
    });

    // 6. Launch instance
    console.log(`[cloud] Launching EC2 instance (${instanceType}, ${region})...`);
    const runParams: any = {
      ImageId: amiId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData).toString('base64'),
      SecurityGroupIds: [sgId],
      TagSpecifications: [{
        ResourceType: 'instance',
        Tags: [
          { Key: PANDO_TAG_KEY, Value: PANDO_TAG_VALUE },
          { Key: 'Name', Value: `pando-compute-${Date.now()}` },
          { Key: 'resource-id', Value: resourceId },
        ],
      }],
    };
    const runResult = await ec2.send(new RunInstancesCommand(runParams));

    const instanceId = runResult.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error('EC2 RunInstances returned no instance ID');

    // 6. Create record
    const record: CloudInstanceRecord = {
      instanceId,
      resourceId,
      region,
      instanceType,
      publicIp: null,
      peerId: null,
      status: 'launching',
      launchedAt: Date.now(),
      terminatedAt: null,
      mode: 'compute',
      apps: [],
      error: null,
    };

    this.instances.set(instanceId, record);
    this.persistInstance(record);

    // 7. Poll for public IP (non-blocking)
    this.pollForPublicIp(ec2, instanceId, DescribeInstancesCommand).catch(err => {
      console.error(`[cloud] Failed to get public IP for ${instanceId}: ${(err as Error).message}`);
    });

    // 8. Wipe credentials from local scope
    // (JavaScript GC will handle the rest, but null out references)
    (creds as any).accessKeyId = '';
    (creds as any).secretAccessKey = '';

    console.log(`[cloud] Instance ${instanceId} launched. Waiting for P2P connection...`);
    return record;
  }

  /**
   * Terminate an instance.
   */
  async terminateInstance(instanceId: string): Promise<void> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Unknown instance: ${instanceId}`);

    const registry = this.node.getResourceRegistry();
    if (!registry) throw new Error('ResourceRegistry not available');

    const credentialJson = await registry.getCredential(record.resourceId);
    if (!credentialJson) throw new Error(`Cannot decrypt AWS credentials for resource ${record.resourceId}`);

    const creds = JSON.parse(credentialJson);
    const { EC2Client, TerminateInstancesCommand } = await import('@aws-sdk/client-ec2');

    const ec2 = new EC2Client({
      region: record.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });

    console.log(`[cloud] Terminating instance ${instanceId}...`);
    await ec2.send(new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    }));

    record.status = 'terminated';
    record.terminatedAt = Date.now();
    this.persistInstance(record);

    // Wipe creds
    creds.accessKeyId = '';
    creds.secretAccessKey = '';

    console.log(`[cloud] Instance ${instanceId} terminated.`);
  }

  /**
   * Check instance health via AWS DescribeInstances.
   */
  async checkInstanceHealth(instanceId: string): Promise<{ state: string; publicIp: string | null }> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Unknown instance: ${instanceId}`);

    const registry = this.node.getResourceRegistry();
    if (!registry) throw new Error('ResourceRegistry not available');

    const credentialJson = await registry.getCredential(record.resourceId);
    if (!credentialJson) throw new Error(`Cannot decrypt AWS credentials`);

    const creds = JSON.parse(credentialJson);
    const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2');

    const ec2 = new EC2Client({
      region: record.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });

    const result = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    }));

    const instance = result.Reservations?.[0]?.Instances?.[0];
    const state = instance?.State?.Name || 'unknown';
    const publicIp = instance?.PublicIpAddress || null;

    // Update record if state changed
    if (state === 'running' && record.status === 'launching') {
      record.status = 'running';
      record.publicIp = publicIp;
      this.persistInstance(record);
    } else if (state === 'terminated' || state === 'shutting-down') {
      record.status = 'terminated';
      record.terminatedAt = record.terminatedAt || Date.now();
      this.persistInstance(record);
    }

    // Wipe creds
    creds.accessKeyId = '';
    creds.secretAccessKey = '';

    return { state, publicIp };
  }

  /**
   * List all tracked instances.
   */
  getInstances(): CloudInstanceRecord[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get a single instance record.
   */
  getInstance(instanceId: string): CloudInstanceRecord | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Associate a P2P peerId with an instance (called when instance connects to network).
   */
  linkPeer(instanceId: string, peerId: string): void {
    const record = this.instances.get(instanceId);
    if (record) {
      record.peerId = peerId;
      record.status = 'running';
      this.persistInstance(record);
      console.log(`[cloud] Instance ${instanceId} linked to peer ${peerId.slice(0, 16)}...`);
    }
  }

  /**
   * Track app deployment to an instance.
   */
  addApp(instanceId: string, projectId: string): void {
    const record = this.instances.get(instanceId);
    if (record && !record.apps.includes(projectId)) {
      record.apps.push(projectId);
      this.persistInstance(record);
    }
  }

  /**
   * Deploy an app to a compute instance via P2P.
   * Sends a deploy-app message to the instance's Pando node.
   * The compute node clones from GitHub (or downloads from S3 for static apps),
   * then serves via its Phase 65 /apps/:appName/* endpoint.
   *
   * NO remote command execution (SSM/SSH) — the P2P network IS the management channel.
   */
  async deployApp(instanceId: string, projectId: string, repoUrl?: string, envVars?: Record<string, string>): Promise<{ url: string; status: string }> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Instance ${instanceId} not found`);
    if (record.status !== 'running') throw new Error(`Instance ${instanceId} is ${record.status}, not running`);
    if (!record.publicIp) throw new Error(`Instance ${instanceId} has no public IP`);
    if (!record.peerId) throw new Error(`Instance ${instanceId} has no linked peerId — wait for P2P connection`);

    const network = this.node.getNetwork();
    if (!network) throw new Error('P2P network not available');

    if (!repoUrl) throw new Error('repoUrl required — GitHub is the source of truth for all deployments');

    // Send deploy command via P2P to the compute node
    const deployPayload: Record<string, any> = {
      type: 'deploy-app',
      projectId,
      repoUrl,
    };
    if (envVars && Object.keys(envVars).length > 0) {
      deployPayload.envVars = envVars;
    }

    try {
      // Use request-reply to get confirmation from compute node
      const requestReply = this.node.getRequestReply();
      if (!requestReply) throw new Error('RequestReply not available — cannot deploy via P2P');

      // 5 min timeout — git clone + npm install can take a while
      const response = await requestReply.request(record.peerId, 'pando/deploy-app', deployPayload, 300_000);
      this.addApp(instanceId, projectId);

      // Phase 70: Construct correct URL from deploy response
      let url: string;
      const payload = response?.payload as any;
      if (payload?.port) {
        // Tier 2: Use actual port from deploy response
        url = `http://${record.publicIp}:${payload.port}/`;
      } else if (payload?.s3Url || payload?.url) {
        // Tier 1: Use S3 URL returned by EC2
        url = payload.s3Url || payload.url;
      } else {
        url = `http://${record.publicIp}/`;
      }

      const status = response?.success ? (payload?.status || 'deployed') : 'failed';
      console.log(`[cloud] P2P deploy to ${instanceId}: success=${response?.success} url=${url} payload=${JSON.stringify(payload)}`);
      return { url, status };
    } catch (err: any) {
      throw new Error(`P2P deploy failed: ${err.message}`);
    }
  }

  /**
   * Phase 67: Upgrade a compute instance via P2P request-reply.
   * Sends pando/upgrade-node request — instance pulls latest code, builds, and restarts.
   */
  async upgradeInstance(instanceId: string): Promise<{ status: string; output?: string; error?: string }> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Instance ${instanceId} not found`);
    if (!record.peerId) throw new Error(`Instance ${instanceId} has no peerId — not connected to P2P yet`);
    if (record.status !== 'running') throw new Error(`Instance ${instanceId} is ${record.status}, not running`);

    const requestReply = this.node.getRequestReply();
    if (!requestReply) throw new Error('RequestReply not available');

    console.log(`[cloud] Upgrading instance ${instanceId} (peer ${record.peerId.slice(0, 12)}) via P2P...`);

    // 5 min timeout — git pull + npm run build can take a while
    const response = await requestReply.request(record.peerId, 'pando/upgrade-node', {}, 300_000);
    if (!response.success) {
      throw new Error(`Upgrade failed: ${response.error || 'unknown error'}`);
    }
    console.log(`[cloud] Upgrade response from ${instanceId}: ${JSON.stringify(response.payload)}`);
    return response.payload || { status: 'unknown' };
  }

  /**
   * Get the serial console output from an EC2 instance (cloud-init logs, boot messages).
   * This is how we monitor instances without SSH.
   */
  async getConsoleOutput(instanceId: string): Promise<{ output: string; timestamp: string | null }> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Instance ${instanceId} not found`);

    const registry = this.node.getResourceRegistry();
    if (!registry) throw new Error('ResourceRegistry not available');

    const credentialJson = await registry.getCredential(record.resourceId);
    if (!credentialJson) throw new Error('Cannot decrypt AWS credentials');

    const creds = JSON.parse(credentialJson);
    const { EC2Client, GetConsoleOutputCommand } = await import('@aws-sdk/client-ec2');

    const ec2 = new EC2Client({
      region: record.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });

    const result = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId }));

    // Wipe creds
    creds.accessKeyId = '';
    creds.secretAccessKey = '';

    const output = result.Output ? Buffer.from(result.Output, 'base64').toString('utf8') : '';
    return { output, timestamp: result.Timestamp?.toISOString() || null };
  }

  // ---- Private helpers ----

  /**
   * Ensure the pando-compute-node security group exists in the region.
   * Returns the security group ID. Throws on failure (never returns null).
   */
  private async ensureSecurityGroup(ec2: any, region: string, commands: any): Promise<string> {
    // Check if it already exists
    try {
      const existing = await ec2.send(new commands.DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: [SECURITY_GROUP_NAME] }],
      }));
      if (existing.SecurityGroups?.length > 0) {
        const sgId = existing.SecurityGroups[0].GroupId;
        console.log(`[cloud] Using existing security group ${SECURITY_GROUP_NAME} (${sgId})`);
        return sgId;
      }
    } catch (err) {
      console.log(`[cloud] Security group lookup failed: ${(err as Error).message}. Creating new one.`);
    }

    // Create new security group
    const createResult = await ec2.send(new commands.CreateSecurityGroupCommand({
      GroupName: SECURITY_GROUP_NAME,
      Description: 'Pando compute node - P2P + API only, no SSH',
    }));
    const sgId = createResult.GroupId;
    if (!sgId) throw new Error('CreateSecurityGroup returned no GroupId');

    // Allow P2P, API, and app ports. No SSH (port 22) — intentional.
    await ec2.send(new commands.AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 4001,
          ToPort: 4001,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Pando P2P' }],
        },
        {
          IpProtocol: 'tcp',
          FromPort: 4000,
          ToPort: 4000,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Pando API and static apps' }],
        },
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'nginx reverse proxy for deployed apps' }],
        },
        {
          IpProtocol: 'tcp',
          FromPort: 3001,
          ToPort: 3100,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Tier 2 backend app ports (legacy)' }],
        },
      ],
    }));

    console.log(`[cloud] Created security group ${SECURITY_GROUP_NAME} (${sgId})`);
    return sgId;
  }

  /**
   * Poll for public IP assignment after instance launch.
   */
  private async pollForPublicIp(ec2: any, instanceId: string, DescribeInstancesCommand: any): Promise<void> {
    const maxAttempts = 30; // 30 * 10s = 5 minutes max
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10s between checks

      try {
        const result = await ec2.send(new DescribeInstancesCommand({
          InstanceIds: [instanceId],
        }));
        const instance = result.Reservations?.[0]?.Instances?.[0];
        const publicIp = instance?.PublicIpAddress;
        const state = instance?.State?.Name;

        if (publicIp) {
          const record = this.instances.get(instanceId);
          if (record) {
            record.publicIp = publicIp;
            record.status = 'running';
            this.persistInstance(record);
            console.log(`[cloud] Instance ${instanceId} running at ${publicIp}`);
          }
          return;
        }

        if (state === 'terminated' || state === 'shutting-down') {
          const record = this.instances.get(instanceId);
          if (record) {
            record.status = 'terminated';
            record.error = 'Instance terminated during startup';
            this.persistInstance(record);
          }
          return;
        }
      } catch {
        // Keep polling
      }
    }

    // Timeout — mark as error
    const record = this.instances.get(instanceId);
    if (record && record.status === 'launching') {
      record.status = 'error';
      record.error = 'Timed out waiting for public IP';
      this.persistInstance(record);
      console.error(`[cloud] Instance ${instanceId} timed out waiting for public IP`);
    }
  }

  /**
   * Generate the user-data (cloud-init) bootstrap script.
   * This runs once at instance boot and sets up the Pando compute node.
   */
  private generateUserData(options: {
    bootstrapPeers: string[];
    mode: NodeMode;
    apiPort: number;
  }): string {
    const bootstrapArgs = options.bootstrapPeers.length > 0
      ? `--bootstrap ${options.bootstrapPeers[0]}`
      : '';

    return `#!/bin/bash
set -eo pipefail
exec > >(tee /var/log/pando-bootstrap.log) 2>&1
echo "[pando-bootstrap] Starting at $(date -u)"

# 1. SECURITY: Remove SSH + SSM FIRST (before anything else)
systemctl stop ssh || true
systemctl disable ssh || true
apt-get remove -y openssh-server || true
apt-get purge -y openssh-server || true
rm -rf /etc/ssh
# Remove SSM agent (pre-installed on Ubuntu AMIs — tripwire would detect it)
snap remove amazon-ssm-agent 2>/dev/null || true
systemctl stop snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null || true
systemctl disable snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null || true
echo "[pando-bootstrap] SSH and SSM removed"

# 2. Disable swap (prevent credential leak to disk)
swapoff -a
sed -i '/swap/d' /etc/fstab
rm -f /swapfile

# 3. Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git build-essential nginx
echo "[pando-bootstrap] Node.js $(node -v) installed, nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# Install PM2 globally
npm install -g pm2
echo "[pando-bootstrap] PM2 $(pm2 -v) installed"

# 4. Clone Pando from public repo and build
git clone ${PUBLIC_REPO} /opt/pando
cd /opt/pando && npm ci
echo "[pando-bootstrap] Dependencies installed"
npm run build
echo "[pando-bootstrap] Pando built successfully"

# 5. Create pando user and give ownership of repo
useradd -r -m -s /bin/false pando
mkdir -p /home/pando/.pando
chown -R pando:pando /home/pando/.pando
chown -R pando:pando /opt/pando
# Set safe.directory so 'pando' user can git pull during upgrades
su -s /bin/bash pando -c "git config --global --add safe.directory /opt/pando"
# Set git identity for upgrade-protocol commits
su -s /bin/bash pando -c "git config --global user.name 'Pando Node'"
su -s /bin/bash pando -c "git config --global user.email 'node@pando.network'"

# Phase 80: Configure nginx for reverse-proxying deployed apps
mkdir -p /etc/nginx/pando-apps
chown pando:pando /etc/nginx/pando-apps
# Base nginx config — include pando app configs
cat > /etc/nginx/sites-available/pando-apps << 'NGINXCONF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Pando deployed apps — each gets /apps/<projectId>/
    include /etc/nginx/pando-apps/*.conf;

    # Default: return 404 for unmatched routes
    location / {
        return 404 '{"error":"No app at this path"}';
        add_header Content-Type application/json;
    }
}
NGINXCONF
ln -sf /etc/nginx/sites-available/pando-apps /etc/nginx/sites-enabled/pando-apps
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "[pando-bootstrap] nginx configured for app hosting"

# Allow pando user to reload nginx without password
echo 'pando ALL=(root) NOPASSWD: /usr/sbin/nginx -s reload' > /etc/sudoers.d/pando-nginx
chmod 440 /etc/sudoers.d/pando-nginx

# PM2 startup — ensure apps survive reboot
su -s /bin/bash pando -c "pm2 startup systemd -u pando --hp /home/pando" || true
echo "[pando-bootstrap] PM2 startup configured"

# 6. Security monitor (tripwire)
cat > /opt/pando/monitor.sh << 'MONITOR_SCRIPT'
${this.generateMonitorScript()}
MONITOR_SCRIPT
chmod +x /opt/pando/monitor.sh

# 7. Systemd service — Pando compute node
cat > /etc/systemd/system/pando-node.service << 'NODESERVICE'
[Unit]
Description=Pando Compute Node
After=network.target

[Service]
Type=simple
User=pando
WorkingDirectory=/opt/pando
ExecStart=/usr/bin/node /opt/pando/packages/node/dist/cli.js --mode compute --port 4001 --api-port ${options.apiPort} ${bootstrapArgs}
Restart=always
RestartSec=5
LimitNOFILE=65535
Environment=HOME=/home/pando
Environment=GATEWAY_PUBLIC_URL=https://gateway-one-mu.vercel.app
${process.env.CREDENTIAL_MASTER_KEY ? `Environment=CREDENTIAL_MASTER_KEY=${process.env.CREDENTIAL_MASTER_KEY}` : '# CREDENTIAL_MASTER_KEY not set on admin node'}
# Compute instances access MongoDB via CredentialStore (CREDENTIAL_MASTER_KEY), not PANDO_STORAGE_URL

[Install]
WantedBy=multi-user.target
NODESERVICE

# 8. Systemd service — Security monitor
cat > /etc/systemd/system/pando-monitor.service << 'MONITORSERVICE'
[Unit]
Description=Pando Security Monitor (Tripwire)
After=pando-node.service

[Service]
Type=simple
ExecStart=/opt/pando/monitor.sh
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
MONITORSERVICE

# 9. Pre-seed API token for remote management
INSTANCE_TOKEN=$(openssl rand -hex 32)
echo -n "$INSTANCE_TOKEN" > /home/pando/.pando/api-token
chown pando:pando /home/pando/.pando/api-token
echo "[pando-bootstrap] API token: $INSTANCE_TOKEN"

# 10. Deploy test app to hosted-apps (if it exists in the repo)
HOSTED_DIR=/home/pando/.pando/hosted-apps/secure-notes
if [ -f /opt/pando/tests/test-app/index.html ]; then
  mkdir -p $HOSTED_DIR
  cp /opt/pando/tests/test-app/index.html $HOSTED_DIR/
  chown -R pando:pando /home/pando/.pando/hosted-apps
  echo "[pando-bootstrap] Test app deployed to hosted-apps/secure-notes"
fi

# 11. Start services
systemctl daemon-reload
systemctl enable pando-node pando-monitor
systemctl start pando-node pando-monitor

echo "[pando-bootstrap] Complete at $(date -u)"
`;
  }

  /**
   * Generate the security monitor (tripwire) bash script.
   * Runs as root. Checks every second for unauthorized access.
   * On ANY intrusion detection: wipe credentials, kill processes, shutdown.
   */
  private generateMonitorScript(): string {
    return `#!/bin/bash
# Pando Instance Security Monitor — Phase 64
# Runs as root. Detects unauthorized access. Wipes and shuts down on intrusion.

echo "[pando-monitor] Security monitor started at $(date -u)"

# Wait for bootstrap to fully complete before arming tripwire
# (cloud-init runs bash as root, which would trigger false positives)
echo "[pando-monitor] Waiting for cloud-init to finish..."
cloud-init status --wait 2>/dev/null || sleep 60
echo "[pando-monitor] Armed at $(date -u)"

PANDO_PID=""

while true; do
  # Find pando node PID if not cached or if process died
  if [ -z "$PANDO_PID" ] || ! kill -0 "$PANDO_PID" 2>/dev/null; then
    PANDO_PID=$(pgrep -f "pando.*cli.js" || echo "")
  fi

  ALARM=0

  # Check 1: Any logged-in users?
  LOGINS=$(who 2>/dev/null | wc -l)
  if [ "$LOGINS" -gt 0 ]; then
    logger "PANDO TRIPWIRE: Active login session detected ($LOGINS users)"
    ALARM=1
  fi

  # Check 2: sshd somehow running?
  if pgrep -x sshd > /dev/null 2>&1; then
    logger "PANDO TRIPWIRE: sshd process detected"
    ALARM=1
  fi

  # Check 3: SSM agent running?
  if pgrep -f "amazon-ssm-agent" > /dev/null 2>&1; then
    logger "PANDO TRIPWIRE: SSM agent detected"
    ALARM=1
  fi

  # Check 4: Debugger attached to pando process?
  if [ -n "$PANDO_PID" ] && [ -f "/proc/$PANDO_PID/status" ]; then
    TRACER=$(grep "^TracerPid:" /proc/$PANDO_PID/status 2>/dev/null | awk '{print $2}')
    if [ -n "$TRACER" ] && [ "$TRACER" != "0" ]; then
      logger "PANDO TRIPWIRE: Debugger attached (TracerPid=$TRACER)"
      ALARM=1
    fi
  fi

  # Check 5: Interactive root login (not background shells from systemd/cron)
  # Only trigger on actual TTY-attached shells (interactive login)
  INTERACTIVE_ROOT=$(w -h 2>/dev/null | grep -c "root" || echo "0")
  if [ "$INTERACTIVE_ROOT" -gt 0 ]; then
    logger "PANDO TRIPWIRE: Interactive root login detected"
    ALARM=1
  fi

  if [ "$ALARM" -eq 1 ]; then
    logger "PANDO TRIPWIRE: === INTRUSION DETECTED — WIPING ==="

    # Kill all pando/node/nginx processes
    killall -9 node nginx 2>/dev/null || true

    # Wipe credential data
    rm -rf /home/pando/.pando/resource_registry* 2>/dev/null || true
    rm -rf /home/pando/.pando/ledger.db* 2>/dev/null || true
    rm -rf /home/pando/.pando/identity.json 2>/dev/null || true
    rm -rf /home/pando/.pando/identities 2>/dev/null || true
    rm -rf /home/pando/.pando/session.json 2>/dev/null || true
    rm -rf /home/pando/.pando/api-token 2>/dev/null || true

    # Overwrite with zeros (paranoid wipe)
    dd if=/dev/zero of=/home/pando/.pando/wipe bs=1M count=10 2>/dev/null || true
    rm -f /home/pando/.pando/wipe

    logger "PANDO TRIPWIRE: Wipe complete. Shutting down."
    shutdown -h now
    exit 1
  fi

  sleep 1
done`;
  }

  /**
   * Persist an instance record to SQLite.
   */
  private persistInstance(record: CloudInstanceRecord): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT OR REPLACE INTO cloud_instances
      (instance_id, resource_id, region, instance_type, public_ip, peer_id, status,
       launched_at, terminated_at, mode, apps, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.instanceId,
      record.resourceId,
      record.region,
      record.instanceType,
      record.publicIp,
      record.peerId,
      record.status,
      record.launchedAt,
      record.terminatedAt,
      record.mode,
      JSON.stringify(record.apps),
      record.error,
    );
  }

  /**
   * Load all instance records from SQLite.
   */
  private loadInstances(): void {
    if (!this.db) return;

    const rows = this.db.prepare('SELECT * FROM cloud_instances').all() as any[];
    for (const row of rows) {
      const record: CloudInstanceRecord = {
        instanceId: row.instance_id,
        resourceId: row.resource_id,
        region: row.region,
        instanceType: row.instance_type,
        publicIp: row.public_ip,
        peerId: row.peer_id,
        status: row.status,
        launchedAt: row.launched_at,
        terminatedAt: row.terminated_at,
        mode: row.mode || 'compute',
        apps: JSON.parse(row.apps || '[]'),
        error: row.error,
      };
      this.instances.set(record.instanceId, record);
    }
  }
}
