import { sign } from '@pando/identity';
import { toString as uint8ArrayToString } from 'uint8arrays';

export class HttpPeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpPeerError';
  }
}

interface PeerIdentity {
  peerId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

interface CapabilityRegistry {
  getAllProfiles(): any[];
}

export class HttpPeerClient {
  private identity: PeerIdentity;
  private capabilityRegistry: CapabilityRegistry;

  constructor(identity: PeerIdentity, capabilityRegistry: CapabilityRegistry) {
    this.identity = identity;
    this.capabilityRegistry = capabilityRegistry;
  }

  getPeerHttpEndpoint(peerId: string): { host: string; port: number } | null {
    const profiles = this.capabilityRegistry.getAllProfiles();
    const profile = profiles.find((p: any) => p.peerId === peerId);
    if (!profile) return null;

    const port = profile.details?.httpApi?.port || 4000;
    // Prefer publicAddress (actual routable IP) over httpApi.host (often 0.0.0.0)
    const host = profile.publicAddress
      || (profile.details?.httpApi?.host && profile.details.httpApi.host !== '0.0.0.0' && profile.details.httpApi.host !== '::'
          ? profile.details.httpApi.host
          : null);

    return host ? { host, port } : null;
  }

  async sendRequest(peerId: string, path: string, payload: any, timeoutMs = 30_000): Promise<any> {
    const endpoint = this.getPeerHttpEndpoint(peerId);
    if (!endpoint) {
      throw new HttpPeerError(`No HTTP endpoint found for peer ${peerId}`);
    }

    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature = await sign(new TextEncoder().encode(body + timestamp), this.identity.privateKey);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Pando-Signature': signature,
      'X-Pando-PeerId': this.identity.peerId,
      'X-Pando-Timestamp': timestamp,
      'X-Pando-PublicKey': uint8ArrayToString(this.identity.publicKey, 'base64'),
    };

    const url = `http://${endpoint.host}:${endpoint.port}${path}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new HttpPeerError(
            `HTTP ${response.status} from peer ${peerId} at ${path}: ${await response.text()}`
          );
        }

        return await response.json();
      } catch (err: any) {
        if (err instanceof HttpPeerError) throw err;

        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw new HttpPeerError(`Request to ${peerId} timed out after ${timeoutMs}ms`);
        }

        if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
          throw new HttpPeerError(`Cannot connect to peer ${peerId} at ${endpoint.host}:${endpoint.port}`);
        }

        lastError = err;
      }
    }

    throw new HttpPeerError(
      `Request to ${peerId} at ${path} failed after 2 attempts: ${lastError?.message ?? 'unknown error'}`
    );
  }

  async storageProxy(peerId: string, method: string, args: any): Promise<any> {
    return this.sendRequest(peerId, '/v1/internal/storage/' + method, args, 15_000);
  }

  async deployApp(peerId: string, payload: any): Promise<any> {
    return this.sendRequest(peerId, '/v1/internal/deploy', payload, 300_000);
  }

  async getCredential(peerId: string, resourceId: string, type: string): Promise<string | null> {
    const response = await this.sendRequest(peerId, '/v1/internal/credential', { resourceId, type }, 30_000);
    return response.credential ?? null;
  }

  async chatProxy(peerId: string, message: string, threadId: string, tier?: string): Promise<any> {
    return this.sendRequest(peerId, '/v1/internal/chat-proxy', { message, threadId, tier }, 30_000);
  }

  /**
   * Dispatch a generic handler request to a peer via HTTP.
   * Routes to /v1/internal/dispatch which looks up handlers by type.
   * Replaces P2P requestReply.request() for unicast operations.
   */
  async dispatchRequest(peerId: string, type: string, payload: any, timeoutMs = 30_000): Promise<any> {
    const response = await this.sendRequest(peerId, '/v1/internal/dispatch', { type, payload }, timeoutMs);
    return response;
  }
}
