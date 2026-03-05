---
id: network
type: infrastructure
domain: p2p
entry: packages/node/src/kernel/network.ts
depends_on: [shared-crypto, shared-types]
depended_by: [ledger-sync, request-reply, reputation, security-monitor, resource-proof, monitor, emission-witness, governance, task-queue, content-registry, resource-marketplace, upgrade-protocol, pando-node]
exposes:
  - start()
  - stop()
  - dialPeer(addr)
  - getListenAddresses()
  - getPeers()
  - getPeerCount()
  - getDiscoverySources()
  - getIdentity()
  - getLibp2p()
  - onMessage(handler)
  - onPeerConnect(handler)
  - sendMessage(targetPeerId, message)
  - broadcast(message)
  - subscribeTopic(topic, handler)
  - publishToTopic(topic, message)
  - subscribeAgentEvents()
  - onAgentEvent(handler)
  - publishAgentEvent(payload)
  - subscribeAgentMessages()
  - onAgentMessage(handler)
  - publishAgentMessage(to, payload)
  - setPeerVersion(peerId, protocolVersion, capabilities)
  - getPeerVersions()
  - getPeerVersion(peerId)
rules: []
last_verified: 2026-02-18
---

# Pando Network

## What It Does
Core P2P networking layer built on libp2p. Manages peer discovery, connections, encrypted messaging, GossipSub pub/sub, and protocol handling for the entire Pando node.

## How It Works
- Creates a libp2p node with TCP + WebSocket + Circuit Relay transports, Noise encryption, Yamux stream multiplexing, mDNS local discovery, optional bootstrap peers, KadDHT, and GossipSub.
- Registers the custom `/pando/1.0.0` protocol for direct peer-to-peer messaging with Ed25519 message signing and verification.
- Tracks peer connections via `peer:connect` / `peer:disconnect` events, maintaining a `Map<string, PeerInfo>` with connection timestamps and discovery sources (mdns, bootstrap, dht, relay, manual).
- Three GossipSub topic layers: `pando/transactions` + `pando/sync` (used by LedgerSync), `pando/agent-events` (used by ProfileSync, MemorySync, ReputationManager), `pando/agent-messages` (used by RequestReplyManager).
- **Phase 92 — Direct TCP capability exchange:** On every peer connect, the node sends its CapabilityProfile via direct TCP stream (`CAPABILITY_PROFILE_DIRECT` MessageType) with a 2-second delay, in addition to GossipSub broadcasts. This guarantees compute peers are discovered even when GossipSub mesh fails to form in small networks (D=6 requires 6+ peers; small networks with 2-3 peers often fail to form a mesh).
- **Phase 93 — Direct TCP request/reply:** `REQUEST_REPLY_REQUEST` and `REQUEST_REPLY_REPLY` MessageTypes added. RequestReplyManager now sends unicast requests via direct TCP stream first (`sendMessage`), falling back to GossipSub broadcast if the direct stream fails. Broadcast `query()` (to: `'*'`) still uses GossipSub.
- Auto-reconnect: if peer count drops to zero, re-dials bootstrap peers AND known peers every 30 seconds.
- Health check: every 60 seconds, syncs the internal peer map with libp2p's actual connection state to remove stale entries and discover missed connections.
- **Peer persistence (Phase 54):** Connected peers saved to `~/.pando/known-peers.json` on connect/disconnect events. On startup, loads known peers and dials them alongside bootstrap. Prunes peers not seen in 7 days. Caps at 50 entries.
- Optional circuit relay server mode (enabled via `--relay` flag) allows NAT-ed peers to connect through this node.

## Gotchas
- The `stopped` flag prevents operations after `stop()` is called, but some timers may fire one more time before clearing.
- Agent message payloads are size-limited to 4096 bytes after JSON serialization -- larger payloads are silently rejected.
- Topic listener handlers are stored in `topicListeners[]` to enable proper cleanup during `stop()`.
- Peer version tracking (`peerVersions`) is populated from AGENT_HELLO messages, not from libp2p protocol negotiation.
- Discovery source uses "first discovery wins" logic -- subsequent discoveries from different sources do not update the recorded source.
- Known peers are saved with a 2-second delay after connection to allow time for address discovery.

## Key Files
- `packages/node/src/kernel/network.ts` -- PandoNetwork class
- `packages/shared/src/types.ts` -- PandoMessage, NodeConfig, PeerInfo, MessageType, PANDO_PROTOCOL
- `packages/shared/src/crypto.ts` -- signMessage, verifySignature
