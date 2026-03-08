/**
 * Resource Proof Challenger — Phase 12.3
 *
 * Periodic challenges to verify nodes actually provide what they claim.
 * Uses RequestReplyManager to send challenges and receive proofs.
 *
 * Challenge types:
 *   1. Storage — send random payload, ask for SHA-256 hash back
 *   2. Compute — send a compute task, verify result within calibrated time
 *   3. Bandwidth — send relay request, verify delivery within timeout
 *
 * Scores are persisted at ~/.pando/security/proof-scores.json
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestReplyManager } from '../core/request-reply.js';
import type { HttpPeerClient } from '../core/http-peer-client.js';
import type { PandoNetwork } from '../kernel/network.js';
import type { ProofResult, ProofScore } from '@pando/shared';

// ── Constants ────────────────────────────────────────────────

const DEFAULT_CHALLENGE_INTERVAL_MS = 5 * 60_000; // 5 minutes
const STORAGE_PAYLOAD_SIZE = 1024;                 // 1 KB
const STORAGE_TIMEOUT_MS = 5_000;                  // 5 seconds
const COMPUTE_TIMEOUT_MS = 10_000;                 // 10 seconds
const BANDWIDTH_TIMEOUT_MS = 5_000;                // 5 seconds (2s delivery + margin)
const MAX_SCORES = 500;
const MAX_RESULTS_PER_PEER = 50;
const SCORE_DECAY_FACTOR = 0.95;                   // Recent challenges matter more

// ── ResourceProofChallenger Class ────────────────────────────

export class ResourceProofChallenger {
  private requestReply: RequestReplyManager;
  private httpPeerClient: HttpPeerClient | null;
  private network: PandoNetwork;
  private localPeerId: string;
  private dataDir: string;

  // Peer scores (peerId → ProofScore)
  private scores: Map<string, ProofScore> = new Map();

  // Recent results (peerId → ProofResult[])
  private results: Map<string, ProofResult[]> = new Map();

  // Challenge loop
  private challengeTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Persistence
  private scoresPath: string;

  constructor(
    requestReply: RequestReplyManager,
    network: PandoNetwork,
    localPeerId: string,
    dataDir: string,
    httpPeerClient?: HttpPeerClient | null,
  ) {
    this.requestReply = requestReply;
    this.httpPeerClient = httpPeerClient ?? null;
    this.network = network;
    this.localPeerId = localPeerId;
    this.dataDir = dataDir;

    const securityDir = join(dataDir, 'security');
    if (!existsSync(securityDir)) {
      mkdirSync(securityDir, { recursive: true });
    }
    this.scoresPath = join(securityDir, 'proof-scores.json');

    this.loadScores();
    this.registerHandlers();
  }

  // ── Challenge Methods ──────────────────────────────────────

  /**
   * Challenge a peer's storage capability.
   * Sends a random 1KB payload and asks for the SHA-256 hash.
   */
  async challengeStorage(peerId: string): Promise<ProofResult> {
    const payload = randomBytes(STORAGE_PAYLOAD_SIZE);
    const expectedHash = createHash('sha256').update(payload).digest('hex');
    const startTime = Date.now();

    try {
      if (!this.httpPeerClient) throw new Error('No HTTP peer client available');
      const reply = await this.httpPeerClient.dispatchRequest(
        peerId, 'storage_challenge', { payload: payload.toString('hex') }, STORAGE_TIMEOUT_MS,
      );

      const responseTimeMs = Date.now() - startTime;
      const passed = reply.success && reply.payload?.hash === expectedHash;

      const result: ProofResult = {
        peerId,
        challengeType: 'storage',
        passed,
        responseTimeMs,
        timestamp: Date.now(),
        details: passed
          ? `Correct hash in ${responseTimeMs}ms`
          : `Incorrect hash or error: ${reply.error || 'hash mismatch'}`,
      };

      this.recordResult(peerId, 'storage', passed);
      return result;
    } catch (err: any) {
      const result: ProofResult = {
        peerId,
        challengeType: 'storage',
        passed: false,
        responseTimeMs: Date.now() - startTime,
        timestamp: Date.now(),
        details: `Challenge failed: ${err.message}`,
      };
      this.recordResult(peerId, 'storage', false);
      return result;
    }
  }

  /**
   * Challenge a peer's compute capability.
   * Sends a 10KB payload and asks for the SHA-256 hash (iterative hashing).
   */
  async challengeCompute(peerId: string): Promise<ProofResult> {
    // Generate a compute task: hash a payload 1000 times iteratively
    const seed = randomBytes(1024).toString('hex');
    const iterations = 1000;

    // Pre-compute expected result
    let expected = seed;
    for (let i = 0; i < iterations; i++) {
      expected = createHash('sha256').update(expected).digest('hex');
    }

    const startTime = Date.now();

    try {
      if (!this.httpPeerClient) throw new Error('No HTTP peer client available');
      const reply = await this.httpPeerClient.dispatchRequest(
        peerId, 'compute_challenge', { seed, iterations }, COMPUTE_TIMEOUT_MS,
      );

      const responseTimeMs = Date.now() - startTime;
      const passed = reply.success && reply.payload?.result === expected;

      const result: ProofResult = {
        peerId,
        challengeType: 'compute',
        passed,
        responseTimeMs,
        timestamp: Date.now(),
        details: passed
          ? `Correct compute result in ${responseTimeMs}ms (${iterations} iterations)`
          : `Incorrect result or error: ${reply.error || 'result mismatch'}`,
      };

      this.recordResult(peerId, 'compute', passed);
      return result;
    } catch (err: any) {
      const result: ProofResult = {
        peerId,
        challengeType: 'compute',
        passed: false,
        responseTimeMs: Date.now() - startTime,
        timestamp: Date.now(),
        details: `Challenge failed: ${err.message}`,
      };
      this.recordResult(peerId, 'compute', false);
      return result;
    }
  }

  /**
   * Challenge a peer's bandwidth capability.
   * Sends a relay challenge: peer must echo back within timeout.
   */
  async challengeBandwidth(peerId: string): Promise<ProofResult> {
    const nonce = randomBytes(32).toString('hex');
    const startTime = Date.now();

    try {
      if (!this.httpPeerClient) throw new Error('No HTTP peer client available');
      const reply = await this.httpPeerClient.dispatchRequest(
        peerId, 'bandwidth_challenge', { nonce, timestamp: Date.now() }, BANDWIDTH_TIMEOUT_MS,
      );

      const responseTimeMs = Date.now() - startTime;
      const passed = reply.success && reply.payload?.nonce === nonce && responseTimeMs <= BANDWIDTH_TIMEOUT_MS;

      const result: ProofResult = {
        peerId,
        challengeType: 'bandwidth',
        passed,
        responseTimeMs,
        timestamp: Date.now(),
        details: passed
          ? `Echo received in ${responseTimeMs}ms`
          : `Failed: ${reply.error || (responseTimeMs > BANDWIDTH_TIMEOUT_MS ? 'too slow' : 'nonce mismatch')}`,
      };

      this.recordResult(peerId, 'bandwidth', passed);
      return result;
    } catch (err: any) {
      const result: ProofResult = {
        peerId,
        challengeType: 'bandwidth',
        passed: false,
        responseTimeMs: Date.now() - startTime,
        timestamp: Date.now(),
        details: `Challenge failed: ${err.message}`,
      };
      this.recordResult(peerId, 'bandwidth', false);
      return result;
    }
  }

  // ── Scoring ────────────────────────────────────────────────

  /**
   * Record the result of a challenge and update the peer's score.
   */
  recordResult(peerId: string, challengeType: string, passed: boolean): void {
    // Store result
    const results = this.results.get(peerId) || [];
    results.push({
      peerId,
      challengeType: challengeType as ProofResult['challengeType'],
      passed,
      responseTimeMs: 0,
      timestamp: Date.now(),
    });

    // Cap stored results per peer
    if (results.length > MAX_RESULTS_PER_PEER) {
      results.splice(0, results.length - MAX_RESULTS_PER_PEER);
    }
    this.results.set(peerId, results);

    // Recalculate score
    this.recalculateScore(peerId);
    this.saveScores();
  }

  /**
   * Recalculate the proof score for a peer from their result history.
   */
  private recalculateScore(peerId: string): void {
    const results = this.results.get(peerId) || [];
    if (results.length === 0) return;

    let storagePassed = 0;
    let storageTotal = 0;
    let computePassed = 0;
    let computeTotal = 0;
    let bandwidthPassed = 0;
    let bandwidthTotal = 0;

    // Weight recent results more heavily
    for (let i = 0; i < results.length; i++) {
      const weight = Math.pow(SCORE_DECAY_FACTOR, results.length - 1 - i);
      const r = results[i];

      switch (r.challengeType) {
        case 'storage':
          storageTotal += weight;
          if (r.passed) storagePassed += weight;
          break;
        case 'compute':
          computeTotal += weight;
          if (r.passed) computePassed += weight;
          break;
        case 'bandwidth':
          bandwidthTotal += weight;
          if (r.passed) bandwidthPassed += weight;
          break;
      }
    }

    const score: ProofScore = {
      peerId,
      storageScore: storageTotal > 0 ? storagePassed / storageTotal : 0,
      computeScore: computeTotal > 0 ? computePassed / computeTotal : 0,
      bandwidthScore: bandwidthTotal > 0 ? bandwidthPassed / bandwidthTotal : 0,
      totalChallenges: results.length,
      lastChallenge: results[results.length - 1]?.timestamp || 0,
    };

    this.scores.set(peerId, score);
  }

  /**
   * Get the proof score for a specific peer.
   */
  getScore(peerId: string): ProofScore {
    return this.scores.get(peerId) || {
      peerId,
      storageScore: 0,
      computeScore: 0,
      bandwidthScore: 0,
      totalChallenges: 0,
      lastChallenge: 0,
    };
  }

  /**
   * Get all proof scores.
   */
  getAllScores(): ProofScore[] {
    return Array.from(this.scores.values());
  }

  // ── Challenge Loop ─────────────────────────────────────────

  /**
   * Start the periodic challenge loop.
   */
  startChallengeLoop(intervalMs: number = DEFAULT_CHALLENGE_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;

    console.log(`[resource-proof] Challenge loop started (interval: ${intervalMs / 1000}s)`);

    this.challengeTimer = setInterval(() => {
      this.runChallengeRound().catch(err => {
        console.error(`[resource-proof] Challenge round error: ${err.message}`);
      });
    }, intervalMs);
  }

  /**
   * Stop the periodic challenge loop.
   */
  stopChallengeLoop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.challengeTimer) {
      clearInterval(this.challengeTimer);
      this.challengeTimer = null;
    }

    this.saveScores();
    console.log('[resource-proof] Challenge loop stopped.');
  }

  /**
   * Run one round of challenges against connected peers.
   * Randomly selects a peer and a challenge type.
   */
  private async runChallengeRound(): Promise<void> {
    const peers = this.network.getPeers();
    if (peers.length === 0) return;

    // Pick a random peer to challenge
    const peer = peers[Math.floor(Math.random() * peers.length)];
    const challengeTypes = ['storage', 'compute', 'bandwidth'] as const;
    const challengeType = challengeTypes[Math.floor(Math.random() * challengeTypes.length)];

    console.log(`[resource-proof] Challenging ${peer.peerId.slice(0, 12)}... with ${challengeType}`);

    try {
      let result: ProofResult;
      switch (challengeType) {
        case 'storage':
          result = await this.challengeStorage(peer.peerId);
          break;
        case 'compute':
          result = await this.challengeCompute(peer.peerId);
          break;
        case 'bandwidth':
          result = await this.challengeBandwidth(peer.peerId);
          break;
      }

      console.log(
        `[resource-proof] ${peer.peerId.slice(0, 12)}: ${challengeType} ${result.passed ? 'PASSED' : 'FAILED'} (${result.responseTimeMs}ms)`,
      );
    } catch (err: any) {
      console.error(`[resource-proof] Challenge error: ${err.message}`);
    }
  }

  // ── Request Handlers (responding to challenges from other peers) ──

  private registerHandlers(): void {
    // Storage challenge handler: receive payload, return SHA-256 hash
    this.requestReply.registerHandler('storage_challenge', async (req) => {
      const { payload } = req.payload || {};
      if (!payload || typeof payload !== 'string') {
        throw new Error('Invalid storage challenge payload');
      }

      const buffer = Buffer.from(payload, 'hex');
      const hash = createHash('sha256').update(buffer).digest('hex');
      return { hash };
    });

    // Compute challenge handler: iterative hashing
    this.requestReply.registerHandler('compute_challenge', async (req) => {
      const { seed, iterations } = req.payload || {};
      if (!seed || typeof seed !== 'string' || typeof iterations !== 'number') {
        throw new Error('Invalid compute challenge payload');
      }

      // Safety: cap iterations to prevent DoS
      const safeIterations = Math.min(iterations, 10_000);
      let result = seed;
      for (let i = 0; i < safeIterations; i++) {
        result = createHash('sha256').update(result).digest('hex');
      }
      return { result };
    });

    // Bandwidth challenge handler: echo nonce back
    this.requestReply.registerHandler('bandwidth_challenge', async (req) => {
      const { nonce } = req.payload || {};
      if (!nonce || typeof nonce !== 'string') {
        throw new Error('Invalid bandwidth challenge payload');
      }
      return { nonce, echoedAt: Date.now() };
    });

    console.log('[resource-proof] Challenge handlers registered (storage, compute, bandwidth)');
  }

  // ── Persistence ────────────────────────────────────────────

  private loadScores(): void {
    try {
      if (existsSync(this.scoresPath)) {
        const data = JSON.parse(readFileSync(this.scoresPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const score of data.slice(0, MAX_SCORES)) {
            if (score.peerId) {
              this.scores.set(score.peerId, score);
            }
          }
        }
      }
    } catch {
      this.scores = new Map();
    }
  }

  private saveScores(): void {
    try {
      const scores = Array.from(this.scores.values()).slice(0, MAX_SCORES);
      writeFileSync(this.scoresPath, JSON.stringify(scores, null, 2));
    } catch (err: any) {
      console.error(`[resource-proof] Failed to save scores: ${err.message}`);
    }
  }
}
