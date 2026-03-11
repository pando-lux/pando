/**
 * API key injection for PandoTeams engine.
 * KB: Loads AI provider keys in priority order: PandoTeams .env → local env → contributed resources (EC2).
 * KB: Keys are NEVER transmitted over P2P — always local or EC2 server-side decrypt.
 * KB: Called from EngineAdapter.start() before engine pool creation.
 * KB: Contributed resources = CredentialStore on EC2 nodes (MongoDB-backed). Non-EC2 nodes silently skip.
 */

import type { ResourceRegistry } from '../platform/resource-registry.js';

const PROVIDER_ENV_MAP: Record<string, string> = {
  'anthropic': 'ANTHROPIC_API_KEY',
  'openai':    'OPENAI_API_KEY',
  'gemini':    'GOOGLE_GENERATIVE_AI_API_KEY',
};

/**
 * Inject AI API keys into process.env for PandoTeams.
 * Priority: local env vars first (contributor's own keys), then contributed
 * resources via CredentialStore (EC2 nodes with MongoDB). Keys never travel
 * over P2P — they're either local or decrypted server-side on EC2.
 */
export async function injectApiKeys(registry?: ResourceRegistry | null): Promise<void> {
  // 1. Load PandoTeams's .env if it exists (contributor's configured keys)
  try {
    const { readFileSync, existsSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const corePkg = require.resolve('@pando-teams/core/package.json');
    const pandoCodeRoot = resolve(dirname(corePkg), '..', '..');
    const envPath = resolve(pandoCodeRoot, '.env');
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf-8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1).trim();
        if (val && !process.env[key]) {
          process.env[key] = val;
        }
      }
      console.log(`[injectApiKeys] Loaded PandoTeams .env from ${pandoCodeRoot}`);
    }
  } catch { /* ok — no .env file or @pando-teams/core not installed */ }

  // 2. Check what's already in local env (contributor's own keys)
  const available: string[] = [];
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (process.env[envVar]) available.push(provider);
  }
  if (available.length > 0) {
    console.log(`[injectApiKeys] Local API keys found: ${available.join(', ')}`);
  }

  // 3. For any missing keys, try contributed resources (EC2 with CredentialStore only)
  if (registry) {
    const aiResources = registry.findResources('ai_api_key');
    for (const resource of aiResources) {
      const provider = resource.metadata?.provider as string | undefined;
      if (!provider) continue;
      const envVar = PROVIDER_ENV_MAP[provider];
      if (!envVar || process.env[envVar]) continue;
      try {
        const key = await registry.getCredential(resource.resourceId);
        if (key) {
          process.env[envVar] = key;
          console.log(`[injectApiKeys] Loaded ${provider} API key from contributed resources (EC2 decrypt)`);
        }
      } catch {
        // Expected on non-EC2 nodes — no CredentialStore, no MongoDB. Not an error.
      }
    }
  }

  // 4. Warn if no keys available at all
  const finalAvailable = Object.entries(PROVIDER_ENV_MAP).filter(([, v]) => process.env[v]);
  if (finalAvailable.length === 0) {
    console.warn('[injectApiKeys] No AI API keys found. PandoTeams will use its own configured provider. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY if needed.');
  }
}
