/**
 * API key injection for PandoTeams engine.
 * KB: Loads AI provider keys in priority order: PandoTeams .env → local env.
 * KB: Keys are NEVER transmitted over P2P — always local.
 * KB: Called from EngineAdapter.start() before engine pool creation.
 * KB: Contributed resources (ResourceRegistry) deleted Phase 6.
 */

const PROVIDER_ENV_MAP: Record<string, string> = {
  'anthropic': 'ANTHROPIC_API_KEY',
  'openai':    'OPENAI_API_KEY',
  'gemini':    'GOOGLE_GENERATIVE_AI_API_KEY',
};

/**
 * Inject AI API keys into process.env for PandoTeams.
 * Priority: PandoTeams .env first, then existing local env vars.
 */
export async function injectApiKeys(): Promise<void> {
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

  // 2. Check what's available in local env
  const available: string[] = [];
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (process.env[envVar]) available.push(provider);
  }
  if (available.length > 0) {
    console.log(`[injectApiKeys] Local API keys found: ${available.join(', ')}`);
  }

  // 3. Warn if no keys available at all
  const finalAvailable = Object.entries(PROVIDER_ENV_MAP).filter(([, v]) => process.env[v]);
  if (finalAvailable.length === 0) {
    console.warn('[injectApiKeys] No AI API keys found. PandoTeams will use its own configured provider. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY if needed.');
  }
}
