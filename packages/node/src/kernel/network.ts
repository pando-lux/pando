import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { webSockets } from '@libp2p/websockets';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { multiaddr } from '@multiformats/multiaddr';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  PANDO_PROTOCOL,
  type PandoMessage,
  type NodeConfig,
  type PeerInfo,
  type CapabilityDeclaration,
  type CapabilityProfile,
  MessageType,
  MESSAGE_VERSION,
  signMessage,
  verifySignature,
} from '@pando/shared';
import { getPrivateKeyFromIdentity, type NodeIdentity } from '@pando/shared';
import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';

// @know
// entity PandoNetwork {
//   type: module
//   blueprint: P2P_KERNEL
//   status: active
//   description: "Core P2P networking layer built on libp2p with TCP+Noise encryption, Yamux muxing, mDNS/bootstrap discovery, GossipSub pub/sub, and circuit relay support."
//   depends_on: [SharedTypes]
//   @gotcha("GossipSub topic subscriptions are deduplicated — subscribing twice to the same topic is a no-op. All topic listeners are cleaned up in stop() to prevent leaks on restart.")
//   @gotcha("Known peers are persisted to ~/.pando/known-peers.json with 7-day TTL and 50-peer cap. On startup, known peers are re-dialed automatically.")
//   @gotcha("Peer exchange includes peerStore announce addresses (public IPs from identify protocol), not just connection addresses. This is critical for NAT/VPC traversal.")
//   @gotcha("Agent message payload limit is 256KB (increased from 8KB) to support P2P storage proxy responses containing large project/thread data.")
//   @why("announce addresses are configured via PUBLIC_IP env var on cloud nodes — required because 0.0.0.0 bind address is not externally reachable behind NAT/VPC.")
//   @why("updateKnownPeer is delayed 3s after connect to allow the identify protocol to populate peerStore with announce addresses.")
// }
// @end

// @know
// lesson IPV6_GATEWAY_FAILURE {
//   in: PandoNetwork
//   what: "Gateway connections fail when using 'localhost'"
//   why: "Node.js may resolve localhost to ::1 (IPv6) which libp2p/Fastify may not bind"
//   fix: "Always use 127.0.0.1 instead of localhost for local connections"
//   severity: warning
//   date: "2026-02"
// }
// @end

// @know
// lesson ED25519_PUBKEY_FROM_PEERID {
//   in: PandoNetwork
//   what: "Cross-node auth failed because ledger stored 'remote-peer' as public key"
//   why: "Remote nodes registered with placeholder public key, making signature verification impossible"
//   fix: "Extract public key from peerId string via peerIdFromString().publicKey — no ledger lookup needed"
//   severity: warning
//   date: "2026-02"
// }
// @end

// @know
// lesson VPC_INTERNAL_IP_LEAK {
//   in: PandoNetwork
//   what: "Peer exchange shared internal VPC IPs (172.31.x.x) that external nodes could not dial"
//   why: "EC2 nodes in the same VPC connect via internal IPs. connection.remoteAddr returns the internal IP, not the public announce address."
//   fix: "getConnectedPeerAddresses() and updateKnownPeer() now also query libp2p peerStore for announce addresses (public IPs from identify protocol). AWS IMDS auto-detects public IP on cloud nodes."
//   severity: critical
//   date: "2026-02"
// }
// @end

// @know
// invariant GOSSIPSUB_DEDUP {
//   rule: "Each GossipSub topic must only be subscribed once per PandoNetwork instance — subscribedTopics Set enforces this"
//   applies_to: [PandoNetwork]
//   severity: warning
// }
// @end

export type MessageHandler = (message: PandoMessage, peerId: string) => void;
export type PeerHandler = (peerId: string) => void;

export type DiscoverySource = 'mdns' | 'bootstrap' | 'dht' | 'relay' | 'manual' | 'unknown';

interface KnownPeer {
  peerId: string;
  addrs: string[];
  lastSeen: number;
}

const KNOWN_PEERS_MAX = 50;
const KNOWN_PEERS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class PandoNetwork {
  private node: Libp2p | null = null;
  private identity: NodeIdentity;
  private config: NodeConfig;
  private peers: Map<string, PeerInfo> = new Map();
  private discoverySources: Map<string, DiscoverySource> = new Map();
  private messageHandlers: MessageHandler[] = [];
  private peerConnectHandlers: PeerHandler[] = [];
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private topicListeners: Array<{ topic: string; handler: (evt: any) => void }> = [];
  private subscribedTopics: Set<string> = new Set();
  // Phase 13: Track peer protocol versions from AGENT_HELLO messages
  private peerVersions: Map<string, { protocolVersion: number; capabilities: string[] }> = new Map();
  // Phase 54.2: Data directory for known-peers.json persistence
  private dataDir: string;
  // Tick counter for periodic discovery sweep
  private reconnectTick = 0;

  constructor(identity: NodeIdentity, config: NodeConfig) {
    this.identity = identity;
    this.config = config;
    this.dataDir = config.dataDir || join(homedir(), '.pando');
  }

  // ── Phase 54.2: Known-Peers Persistence ──

  private get knownPeersPath(): string {
    return join(this.dataDir, 'known-peers.json');
  }

  private loadKnownPeers(): KnownPeer[] {
    try {
      const data = readFileSync(this.knownPeersPath, 'utf-8');
      const peers: KnownPeer[] = JSON.parse(data);
      const cutoff = Date.now() - KNOWN_PEERS_TTL_MS;
      return peers.filter(p => p.lastSeen > cutoff).slice(0, KNOWN_PEERS_MAX);
    } catch {
      return [];
    }
  }

  private saveKnownPeers(peers: KnownPeer[]): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const pruned = peers
        .filter(p => p.lastSeen > Date.now() - KNOWN_PEERS_TTL_MS)
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, KNOWN_PEERS_MAX);
      writeFileSync(this.knownPeersPath, JSON.stringify(pruned, null, 2));
    } catch (err: any) {
      console.error(`[known-peers] Failed to save: ${err.message}`);
    }
  }

  /** Get a peer's addresses from the peerStore (includes announce/public IPs from identify protocol) */
  private async getPeerStoreAddresses(peerId: string): Promise<string[]> {
    if (!this.node) return [];
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerIdObj = peerIdFromString(peerId);
      const peerInfo = await this.node.peerStore.get(peerIdObj);
      return peerInfo.addresses
        .map(a => a.multiaddr.toString())
        .filter(a => !a.includes('/p2p-circuit/'));
    } catch {
      return []; // peer not in store yet
    }
  }

  private async updateKnownPeer(peerId: string): Promise<void> {
    if (!this.node || peerId === this.identity.peerId) return;
    const known = this.loadKnownPeers();
    const addrSet = new Set<string>();
    // Connection addresses (current TCP socket — may be internal VPC IPs)
    const connections = this.node.getConnections().filter(c => c.remotePeer.toString() === peerId);
    for (const c of connections) {
      const addr = c.remoteAddr.toString();
      if (!addr.includes('/p2p-circuit/')) addrSet.add(addr);
    }
    // PeerStore addresses (includes announce/public IPs from identify protocol)
    const peerStoreAddrs = await this.getPeerStoreAddresses(peerId);
    for (const addr of peerStoreAddrs) {
      addrSet.add(addr);
    }
    const addrs = Array.from(addrSet);
    if (addrs.length === 0) return; // no dialable address, skip

    const existing = known.find(p => p.peerId === peerId);
    if (existing) {
      existing.addrs = addrs;
      existing.lastSeen = Date.now();
    } else {
      known.push({ peerId, addrs, lastSeen: Date.now() });
    }
    this.saveKnownPeers(known);
  }

  private removeKnownPeer(peerId: string): void {
    const known = this.loadKnownPeers();
    const filtered = known.filter(p => p.peerId !== peerId);
    if (filtered.length !== known.length) {
      this.saveKnownPeers(filtered);
    }
  }

  private async dialKnownPeers(): Promise<void> {
    if (!this.node) return;
    const known = this.loadKnownPeers();
    if (known.length === 0) return;
    const toDial = known.filter(p => !this.peers.has(p.peerId));
    if (toDial.length === 0) return;
    console.log(`[known-peers] Dialing ${toDial.length} known peers in parallel...`);
    // Dial all known peers concurrently with a per-peer timeout
    await Promise.allSettled(toDial.map(async (peer) => {
      for (const addr of peer.addrs) {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 5_000);
          await this.node!.dial(multiaddr(addr), { signal: ac.signal });
          clearTimeout(timer);
          console.log(`[known-peers] Connected to ${peer.peerId.slice(0, 16)}...`);
          return; // connected via one addr, skip the rest
        } catch {
          // addr may be stale or timed out
        }
      }
    }));
  }

  async start(): Promise<void> {
    const privateKey = getPrivateKeyFromIdentity(this.identity);

    // Set up peer discovery: MDNS for local + bootstrap for known peers
    const peerDiscovery: any[] = [mdns()];
    if (this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(bootstrap({ list: this.config.bootstrapPeers }));
    }

    // Transports: TCP + WebSockets + Circuit Relay (all nodes can use relays)
    const transports: any[] = [
      tcp(),
      webSockets(),
      circuitRelayTransport(),
    ];

    // Listen addresses: TCP + WebSocket
    const listenAddrs = [
      `/ip4/0.0.0.0/tcp/${this.config.listenPort}`,
      `/ip4/0.0.0.0/tcp/0/ws`,
    ];

    // Announce addresses: tell other peers our public IP so they can dial us directly.
    // Required for nodes behind NAT/VPC (EC2, VPS) where the bound address (0.0.0.0)
    // differs from the externally reachable address. Set PUBLIC_IP env var on cloud nodes.
    const announceAddrs: string[] = [];
    if (this.config.publicIp && this.config.listenPort > 0) {
      announceAddrs.push(`/ip4/${this.config.publicIp}/tcp/${this.config.listenPort}`);
      console.log(`[network] Public IP announce: /ip4/${this.config.publicIp}/tcp/${this.config.listenPort}`);
    }

    // Services: core + optional relay server + DCUtR hole-punching
    const services: Record<string, any> = {
      identify: identify(),
      dht: kadDHT({ clientMode: false }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        // Low-latency tuning: flood-publish sends to ALL mesh peers directly
        // instead of relying on gossip forwarding — ideal for small networks (<20 nodes)
        floodPublish: true,
        // Faster mesh maintenance (default 1000ms)
        heartbeatInterval: 700,
      }),
      dcutr: dcutr(),
    };

    // Relay serving is opt-in (--relay flag sets config.relay = true)
    if (this.config.relay) {
      services.relay = circuitRelayServer();
      console.log('[relay] Circuit relay server enabled — this node will relay connections for NAT-ed peers');
    }

    this.node = await createLibp2p({
      privateKey,
      addresses: {
        listen: listenAddrs,
        ...(announceAddrs.length > 0 ? { announce: announceAddrs } : {}),
      },
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux({
        // Keep connections warm to reduce latency on idle links
        enableKeepAlive: true,
        keepAliveInterval: 15_000, // 15s keepalive pings
      })],
      peerDiscovery,
      services,
    });

    // Register the Pando messaging protocol
    this.node.handle(PANDO_PROTOCOL, async ({ stream, connection }) => {
      await this.handleIncomingStream(stream, connection);
    });

    // Extract bootstrap peer IDs for discovery source detection
    const bootstrapPeerIds = new Set<string>();
    for (const addr of this.config.bootstrapPeers) {
      const parts = addr.split('/p2p/');
      if (parts.length > 1) bootstrapPeerIds.add(parts[1]);
    }

    // Track peer discovery source (fires before peer:connect)
    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = (evt.detail as any).id?.toString?.() ?? evt.detail.toString();
      // Only set source if not already known (first discovery wins)
      if (!this.discoverySources.has(peerId)) {
        let source: DiscoverySource = 'unknown';
        if (bootstrapPeerIds.has(peerId)) {
          source = 'bootstrap';
        } else {
          // If we have bootstrap peers configured and this isn't one of them,
          // it's most likely mDNS (local network discovery)
          source = 'mdns';
        }
        this.discoverySources.set(peerId, source);
        console.log(`[discovery] Peer discovered via ${source}: ${peerId.slice(0, 16)}...`);
      }
    });

    // Track peer connections
    this.node.addEventListener('peer:connect', (evt) => {
      const peerIdObj = evt.detail;
      const peerId = peerIdObj.toString();
      const source = this.discoverySources.get(peerId) || 'unknown';
      console.log(`Peer connected (via ${source}): ${peerId.slice(0, 16)}...`);
      this.peers.set(peerId, {
        peerId,
        addresses: [],
        tier: 1,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      });
      // Phase 54.2: Persist known peer — delay 3s to allow identify protocol to populate
      // peerStore with announce addresses (public IPs). Without delay, saved addresses
      // may be incomplete, causing stale reconnection attempts.
      setTimeout(() => this.updateKnownPeer(peerId).catch(() => {}), 3_000);
      // Notify handlers
      for (const handler of this.peerConnectHandlers) {
        try { handler(peerId); } catch {}
      }
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      console.log(`Peer disconnected: ${peerId.slice(0, 16)}...`);
      this.peers.delete(peerId);
      // Keep discovery source in map for historical reference
    });

    await this.node.start();

    // Phase 54.2: Dial known peers from previous sessions
    this.dialKnownPeers().catch(() => {});

    // Auto-reconnect: if peer count drops to 0, re-dial bootstrap peers + known peers
    if (this.config.bootstrapPeers.length > 0) {
      this.reconnectTimer = setInterval(() => this.checkAndReconnect(), 10_000);
    }

    // Health check: remove stale peers every 60s
    this.healthTimer = setInterval(() => this.healthCheck(), 60_000);
  }

  /**
   * If we have no peers, aggressively reconnect to bootstrap + known peers.
   * If we have some peers, periodically sweep known-peers.json for new nodes
   * that joined since our last check (every ~30s).
   */
  private async checkAndReconnect(): Promise<void> {
    if (this.stopped || !this.node) return;
    this.reconnectTick++;

    if (this.peers.size === 0) {
      console.log('[reconnect] No peers — attempting to re-dial bootstrap + known peers in parallel...');
      const bootstrapDials = this.config.bootstrapPeers.map(async (addr) => {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 5_000);
          await this.node!.dial(multiaddr(addr), { signal: ac.signal });
          clearTimeout(timer);
          console.log(`[reconnect] Dialed bootstrap ${addr.slice(0, 40)}...`);
        } catch {
          // Bootstrap peer may be offline — that's ok
        }
      });
      await Promise.allSettled([...bootstrapDials, this.dialKnownPeers()]);
      return;
    }

    // Periodic discovery sweep: every 30s (10s interval × 3), try dialing
    // any known peers we're not yet connected to. This catches new nodes
    // that were added to known-peers via peer exchange but not yet dialed.
    if (this.reconnectTick % 3 === 0) {
      this.dialKnownPeers().catch(() => {});
    }
  }

  /**
   * Sync peer tracking with libp2p's actual connection state.
   * Only remove peers that libp2p confirms are disconnected.
   */
  private healthCheck(): void {
    if (this.stopped || !this.node) return;

    // Get libp2p's actual active connections
    const activeConnections = new Set(
      this.node.getConnections().map(c => c.remotePeer.toString())
    );

    for (const [peerId] of this.peers) {
      if (!activeConnections.has(peerId)) {
        console.log(`[health] Removing disconnected peer: ${peerId.slice(0, 16)}...`);
        this.peers.delete(peerId);
      }
    }

    // Also add any connected peers we're not tracking (reconnect recovery)
    for (const peerId of activeConnections) {
      if (!this.peers.has(peerId) && peerId !== this.identity.peerId) {
        console.log(`[health] Re-tracking connected peer: ${peerId.slice(0, 16)}...`);
        this.peers.set(peerId, {
          peerId,
          addresses: [],
          tier: 1,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
        });
      }
    }
  }

  /**
   * Dial a peer by multiaddr string. Used by /connect command.
   */
  async dialPeer(addr: string): Promise<string> {
    if (!this.node) throw new Error('Node not started');
    const ma = multiaddr(addr);
    const connection = await this.node.dial(ma);
    const peerId = connection.remotePeer.toString();
    // Mark as manual if not already discovered via another method
    if (!this.discoverySources.has(peerId)) {
      this.discoverySources.set(peerId, 'manual');
      console.log(`[discovery] Peer connected via manual dial: ${peerId.slice(0, 16)}...`);
    }
    return peerId;
  }

  getListenAddresses(): string[] {
    if (!this.node) return [];
    return this.node.getMultiaddrs().map((ma) => ma.toString());
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  /** Get connected peer addresses for peer exchange (share with other nodes so they can dial).
   *  Combines connection addresses + saved known-peers + peerStore announce addresses. */
  async getConnectedPeerAddresses(): Promise<{ peerId: string; addrs: string[] }[]> {
    if (!this.node) return [];
    const known = this.loadKnownPeers();
    const result: { peerId: string; addrs: string[] }[] = [];
    for (const peerId of this.peers.keys()) {
      const addrSet = new Set<string>();
      // Connection addresses (current TCP socket — may be internal VPC IPs)
      const connections = this.node.getConnections().filter(c => c.remotePeer.toString() === peerId);
      for (const c of connections) {
        const addr = c.remoteAddr.toString();
        if (!addr.includes('/p2p-circuit/')) addrSet.add(addr);
      }
      // Known-peer saved addresses (often include public/announce IPs from previous sessions)
      const knownPeer = known.find(p => p.peerId === peerId);
      if (knownPeer) {
        for (const addr of knownPeer.addrs) {
          if (!addr.includes('/p2p-circuit/')) addrSet.add(addr);
        }
      }
      // PeerStore addresses (includes announce/public IPs from identify protocol)
      const peerStoreAddrs = await this.getPeerStoreAddresses(peerId);
      for (const addr of peerStoreAddrs) {
        addrSet.add(addr);
      }
      // Ensure all addresses include /p2p/ suffix for dialability
      const addrs = Array.from(addrSet).map(a =>
        a.includes('/p2p/') ? a : `${a}/p2p/${peerId}`
      );
      if (addrs.length > 0) {
        result.push({ peerId, addrs });
      }
    }
    return result;
  }

  getDiscoverySources(): Map<string, DiscoverySource> {
    return this.discoverySources;
  }

  // Phase 13: Peer version tracking
  setPeerVersion(peerId: string, protocolVersion: number, capabilities: string[]): void {
    this.peerVersions.set(peerId, { protocolVersion, capabilities });
  }

  getPeerVersions(): Map<string, { protocolVersion: number; capabilities: string[] }> {
    return new Map(this.peerVersions);
  }

  getPeerVersion(peerId: string): { protocolVersion: number; capabilities: string[] } | undefined {
    return this.peerVersions.get(peerId);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPeerConnect(handler: PeerHandler): void {
    this.peerConnectHandlers.push(handler);
  }

  async sendMessage(targetPeerId: string, message: PandoMessage): Promise<void> {
    if (!this.node) throw new Error('Node not started');

    // Sign the message with our Ed25519 private key
    const sig = await signMessage(message, this.identity.privateKey);
    message.signature = sig;

    // Find connection to peer
    const connections = this.node.getConnections().filter(
      (c) => c.remotePeer.toString() === targetPeerId
    );

    if (connections.length === 0) {
      throw new Error(`Not connected to peer: ${targetPeerId}`);
    }

    const stream = await connections[0].newStream(PANDO_PROTOCOL);
    const encoded = uint8ArrayFromString(JSON.stringify(message));

    await pipe(
      [encoded],
      (source) => lp.encode(source),
      stream.sink
    );
  }

  async broadcast(message: PandoMessage): Promise<void> {
    const peers = Array.from(this.peers.keys());
    const results = await Promise.allSettled(
      peers.map((peerId) => this.sendMessage(peerId, message))
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.log(`Broadcast: ${peers.length - failures.length}/${peers.length} delivered`);
    }
  }

  getIdentity(): NodeIdentity {
    return this.identity;
  }

  getLibp2p(): Libp2p | null {
    return this.node;
  }

  /**
   * Subscribe to a GossipSub topic.
   */
  async subscribeTopic(topic: string, handler: (message: PandoMessage) => void): Promise<void> {
    if (!this.node) throw new Error('Node not started');
    const pubsub = (this.node.services as any).pubsub;
    if (!pubsub) throw new Error('GossipSub not available');

    // Prevent duplicate subscriptions for the same topic
    if (this.subscribedTopics.has(topic)) return;
    this.subscribedTopics.add(topic);

    pubsub.subscribe(topic);

    const listener = (evt: any) => {
      if (evt.detail.topic !== topic) return;
      try {
        const decoded = uint8ArrayToString(evt.detail.data);
        const message: PandoMessage = JSON.parse(decoded);
        // v2.2: Log forward-compat warning for future protocol versions.
        // Old nodes (version=0/undefined) are still processed — backward compat.
        if (message.version !== undefined && message.version > MESSAGE_VERSION) {
          console.warn(`[gossip] Received message with future version ${message.version} on ${topic} — processing anyway`);
        }
        handler(message);
      } catch (err) {
        console.error('Failed to decode GossipSub message:', err);
      }
    };

    // Store reference for cleanup in stop()
    this.topicListeners.push({ topic, handler: listener });
    pubsub.addEventListener('message', listener);
  }

  /**
   * Publish a signed message to a GossipSub topic.
   * v2.2: Stamps version = MESSAGE_VERSION on every outgoing envelope.
   */
  async publishToTopic(topic: string, message: PandoMessage): Promise<void> {
    if (!this.node) throw new Error('Node not started');
    const pubsub = (this.node.services as any).pubsub;
    if (!pubsub) throw new Error('GossipSub not available');

    // Stamp protocol version on outgoing envelope
    message.version = MESSAGE_VERSION;

    // Sign the message
    const sig = await signMessage(message, this.identity.privateKey);
    message.signature = sig;

    const encoded = uint8ArrayFromString(JSON.stringify(message));
    await pubsub.publish(topic, encoded);
  }

  // ── Agent Events GossipSub (Cross-Node) ──

  private static readonly TOPIC_AGENT_EVENTS = 'pando/agent-events';
  private static readonly TOPIC_TASKS = 'pando/tasks';
  private agentEventHandlers: Array<(payload: any, fromPeerId: string) => void> = [];
  private taskEventHandlers: Array<(payload: any, fromPeerId: string) => void> = [];

  /**
   * Subscribe to cross-node agent events via GossipSub.
   * Handler receives the parsed agent event payload and the originating peer ID.
   */
  async subscribeAgentEvents(): Promise<void> {
    await this.subscribeTopic(PandoNetwork.TOPIC_AGENT_EVENTS, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      // Skip events that originated from this node (GossipSub may echo back)
      if (fromPeerId === this.identity.peerId) return;
      for (const handler of this.agentEventHandlers) {
        try {
          handler(message.payload, fromPeerId);
        } catch (err) {
          console.error('[agent-events] Handler error:', err);
        }
      }
    });
    console.log(`[agent-events] Subscribed to GossipSub topic: ${PandoNetwork.TOPIC_AGENT_EVENTS}`);
  }

  /**
   * Register a handler for incoming remote agent events.
   */
  onAgentEvent(handler: (payload: any, fromPeerId: string) => void): void {
    this.agentEventHandlers.push(handler);
  }

  /**
   * Publish an agent event to all connected peers via GossipSub.
   * Payload is included in message.payload. Max 4KB enforced.
   */
  async publishAgentEvent(payload: any): Promise<void> {
    const encoded = JSON.stringify(payload);
    if (encoded.length > 4096) {
      console.warn(`[agent-events] Payload too large (${encoded.length} bytes > 4096), dropping`);
      return;
    }
    const message = {
      type: 'agent_event' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload,
    };
    await this.publishToTopic(PandoNetwork.TOPIC_AGENT_EVENTS, message as any);
  }

  // ── Agent Messages GossipSub (Cross-Node Message Broker) ──

  private static readonly TOPIC_AGENT_MESSAGES = 'pando/agent-messages';
  private agentMessageHandlers: Array<(msg: any, fromPeerId: string) => void> = [];

  async subscribeAgentMessages(): Promise<void> {
    await this.subscribeTopic(PandoNetwork.TOPIC_AGENT_MESSAGES, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.identity.peerId) return;
      for (const handler of this.agentMessageHandlers) {
        try {
          handler(message.payload, fromPeerId);
        } catch (err) {
          console.error('[agent-messages] Handler error:', err);
        }
      }
    });
    console.log(`[agent-messages] Subscribed to GossipSub topic: ${PandoNetwork.TOPIC_AGENT_MESSAGES}`);
  }

  onAgentMessage(handler: (msg: any, fromPeerId: string) => void): void {
    this.agentMessageHandlers.push(handler);
  }

  async publishAgentMessage(targetPeerId: string, agentMsg: any): Promise<void> {
    const payload = { targetPeerId, agentMsg };
    const encoded = JSON.stringify(payload);
    // Phase 83: Increased from 8KB to 256KB to support P2P storage proxy responses
    // (queryRecords can return tens of KB of project/thread data)
    if (encoded.length > 262144) {
      console.warn(`[agent-messages] Payload too large (${encoded.length} bytes > 256KB), dropping`);
      return;
    }
    const message = {
      type: 'agent_message' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload,
    };
    await this.publishToTopic(PandoNetwork.TOPIC_AGENT_MESSAGES, message as any);
  }

  // -- Task Events GossipSub (Cross-Node) --

  async subscribeTaskEvents(): Promise<void> {
    await this.subscribeTopic(PandoNetwork.TOPIC_TASKS, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.identity.peerId) return;
      for (const handler of this.taskEventHandlers) {
        try {
          handler(message.payload, fromPeerId);
        } catch (err) {
          console.error('[task-events] Handler error:', err);
        }
      }
    });
    console.log(`[task-events] Subscribed to GossipSub topic: ${PandoNetwork.TOPIC_TASKS}`);
  }

  onTaskEvent(handler: (payload: any, fromPeerId: string) => void): void {
    this.taskEventHandlers.push(handler);
  }

  async publishTaskEvent(event: {
    type: 'created' | 'claimed' | 'completed' | 'timeline';
    task: { id: string; title: string; [key: string]: any };
    // Phase 8: Cross-node fields for completed events
    output?: string;
    executedByNode?: string;
    executingNode?: string;
    duration?: number;
    // Phase 8.3: Timeline event data
    timelineEvent?: { timestamp: string; event: string; detail: string; metadata?: Record<string, any> };
  }): Promise<void> {
    const message = {
      type: 'task_event' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload: event,
    };
    await this.publishToTopic(PandoNetwork.TOPIC_TASKS, message as any);
  }

  // ── Capability Declaration GossipSub (Cross-Node) ──

  private static readonly TOPIC_CAPABILITIES = 'pando/capabilities';
  private capabilityHandlers: Array<(declaration: CapabilityDeclaration, fromPeerId: string) => void> = [];
  private capabilityProfileHandlers: Array<(profile: CapabilityProfile, fromPeerId: string) => void> = [];
  private priceBroadcastHandlers: Array<(priceList: any, fromPeerId: string) => void> = [];
  private peerCapabilities: Map<string, CapabilityDeclaration> = new Map();

  /**
   * Subscribe to capability declarations from peers via GossipSub.
   * Handles both legacy CapabilityDeclaration and Phase A CapabilityProfile messages.
   */
  async subscribeCapabilities(): Promise<void> {
    await this.subscribeTopic(PandoNetwork.TOPIC_CAPABILITIES, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.identity.peerId) return;

      const payload = message.payload as any;

      // Phase D: Price broadcast (has prices object)
      if (payload.prices !== undefined && payload.updatedAt !== undefined) {
        for (const handler of this.priceBroadcastHandlers) {
          try {
            handler(payload, fromPeerId);
          } catch (err) {
            console.error('[capabilities] Price broadcast handler error:', err);
          }
        }
        return;
      }

      // Phase A: CapabilityProfile has schemaVersion field
      if (payload.schemaVersion !== undefined) {
        const profile = payload as CapabilityProfile;
        for (const handler of this.capabilityProfileHandlers) {
          try {
            handler(profile, fromPeerId);
          } catch (err) {
            console.error('[capabilities] Profile handler error:', err);
          }
        }
        return;
      }

      // Legacy: CapabilityDeclaration has capabilities array
      const declaration = payload as CapabilityDeclaration;
      // Store latest capability declaration for this peer
      this.peerCapabilities.set(fromPeerId, declaration);
      for (const handler of this.capabilityHandlers) {
        try {
          handler(declaration, fromPeerId);
        } catch (err) {
          console.error('[capabilities] Handler error:', err);
        }
      }
    });
    console.log(`[capabilities] Subscribed to GossipSub topic: ${PandoNetwork.TOPIC_CAPABILITIES}`);
  }

  /**
   * Register a handler for incoming legacy capability declarations.
   */
  onCapabilityDeclaration(handler: (declaration: CapabilityDeclaration, fromPeerId: string) => void): void {
    this.capabilityHandlers.push(handler);
  }

  /**
   * Register a handler for incoming Phase A capability profiles.
   */
  onCapabilityProfile(handler: (profile: CapabilityProfile, fromPeerId: string) => void): void {
    this.capabilityProfileHandlers.push(handler);
  }

  /**
   * Register a handler for incoming Phase D price broadcasts.
   */
  onPriceBroadcast(handler: (priceList: any, fromPeerId: string) => void): void {
    this.priceBroadcastHandlers.push(handler);
  }

  /**
   * Broadcast this node's legacy capabilities to all peers via GossipSub.
   */
  async publishCapabilities(declaration: CapabilityDeclaration): Promise<void> {
    const message = {
      type: 'capability_declaration' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload: declaration,
    };
    await this.publishToTopic(PandoNetwork.TOPIC_CAPABILITIES, message as any);
  }

  /**
   * Broadcast this node's Phase A capability profile to all peers via GossipSub.
   */
  async publishCapabilityProfile(profile: CapabilityProfile): Promise<void> {
    const message = {
      type: 'capability_profile' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload: profile,
    };
    await this.publishToTopic(PandoNetwork.TOPIC_CAPABILITIES, message as any);
  }

  /**
   * Get stored capability declarations from connected peers.
   */
  getPeerCapabilityDeclarations(): Map<string, CapabilityDeclaration> {
    return new Map(this.peerCapabilities);
  }

  static readonly TOPIC_MANAGERS = 'pando/managers';

  // v2.4: Node compromise notification topic
  static readonly TOPIC_NODE_COMPROMISED = 'pando/node-compromised';
  private nodeCompromisedHandlers: Array<(peerId: string, reason: string, timestamp: number) => void> = [];

  /**
   * v2.4: Broadcast that this node has been compromised.
   * Other nodes should stop routing credentials to this peerId.
   */
  async publishNodeCompromised(reason: string): Promise<void> {
    const message = {
      type: 'node_compromised' as any,
      from: this.identity.peerId,
      timestamp: Date.now(),
      payload: { peerId: this.identity.peerId, reason, timestamp: Date.now() },
    };
    try {
      await this.publishToTopic(PandoNetwork.TOPIC_NODE_COMPROMISED, message as any);
      console.warn(`[security] TRIPWIRE: Broadcast node_compromised to network (reason: ${reason})`);
    } catch (err: any) {
      console.error(`[security] Failed to broadcast node_compromised: ${err.message}`);
    }
  }

  /**
   * v2.4: Subscribe to node_compromised broadcasts from peers.
   */
  async subscribeNodeCompromised(): Promise<void> {
    await this.subscribeTopic(PandoNetwork.TOPIC_NODE_COMPROMISED, (message) => {
      const payload = message.payload as any;
      if (!payload?.peerId) return;
      const fromPeerId: string = payload.peerId;
      const reason: string = payload.reason || 'unknown';
      const timestamp: number = payload.timestamp || Date.now();
      for (const handler of this.nodeCompromisedHandlers) {
        try { handler(fromPeerId, reason, timestamp); } catch {}
      }
    });
    console.log(`[security] Subscribed to node_compromised notifications`);
  }

  onNodeCompromised(handler: (peerId: string, reason: string, timestamp: number) => void): void {
    this.nodeCompromisedHandlers.push(handler);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.node) {
      // Remove all GossipSub topic listeners to prevent leaks on restart
      try {
        const pubsub = (this.node.services as any).pubsub;
        if (pubsub) {
          for (const entry of this.topicListeners) {
            pubsub.removeEventListener('message', entry.handler);
          }
          for (const topic of this.subscribedTopics) {
            try { pubsub.unsubscribe(topic); } catch {}
          }
        }
      } catch {}
      this.topicListeners = [];
      this.subscribedTopics.clear();
      this.agentEventHandlers = [];
      this.taskEventHandlers = [];
      this.agentMessageHandlers = [];
      this.capabilityHandlers = [];

      await this.node.stop();
      this.node = null;
    }
  }

  private async handleIncomingStream(stream: Stream, connection: Connection): Promise<void> {
    try {
      await pipe(
        stream.source,
        (source) => lp.decode(source),
        async (source) => {
          for await (const msg of source) {
            const decoded = uint8ArrayToString(msg.subarray());
            const message: PandoMessage = JSON.parse(decoded);
            const fromPeer = connection.remotePeer.toString();

            // Verify signature if present
            if (message.signature) {
              const peer = this.peers.get(fromPeer);
              if (peer?.publicKey) {
                const valid = await verifySignature(message, message.signature, peer.publicKey);
                if (!valid) {
                  console.warn(`[REJECTED] Invalid signature from ${fromPeer.slice(0, 16)}...`);
                  continue;
                }
              } else {
                // Signed message from unknown peer — reject (cannot verify without public key)
                console.warn(`[REJECTED] Signed message from unknown peer ${fromPeer.slice(0, 16)}... (no public key on file)`);
                continue;
              }
            }

            // Update last seen
            const peer = this.peers.get(fromPeer);
            if (peer) peer.lastSeen = Date.now();

            // Handle pings automatically
            if (message.type === MessageType.PING) {
              await this.sendMessage(fromPeer, {
                type: MessageType.PONG,
                from: this.identity.peerId,
                timestamp: Date.now(),
                payload: { uptime: process.uptime() },
              });
            }

            // Notify handlers
            for (const handler of this.messageHandlers) {
              handler(message, fromPeer);
            }
          }
        }
      );
    } catch (err) {
      // Stream closed or error — normal during disconnect
    }
  }
}
