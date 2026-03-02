/**
 * Hosting Adapters — Provider-agnostic gateway deployment.
 *
 * Each adapter takes a decrypted deploy token + gateway directory, deploys,
 * and returns a URL. Adding a new provider = implement HostingAdapter + register.
 */

import type { HostingProvider } from '@pando/shared';

export interface HostingAdapter {
  readonly provider: HostingProvider;
  deploy(token: string, cwd: string, meta?: { commitHash?: string }): Promise<{ url: string; success: boolean; error?: string }>;
  healthCheck(url: string): Promise<boolean>;
}

// --- Vercel ---

export class VercelAdapter implements HostingAdapter {
  readonly provider = 'vercel' as const;

  async deploy(token: string, cwd: string, meta?: { commitHash?: string }): Promise<{ url: string; success: boolean; error?: string }> {
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync(`vercel deploy --prod --yes --token ${token}`, {
        cwd, timeout: 180_000, stdio: 'pipe', encoding: 'utf-8', windowsHide: true,
      });
      // Vercel outputs the production URL as the last non-empty line
      const lines = output.trim().split('\n').filter(Boolean);
      const url = lines[lines.length - 1]?.trim() || '';
      return { url, success: true };
    } catch (err: any) {
      const error = err.stderr?.toString()?.slice(0, 200) || err.message;
      return { url: '', success: false, error };
    }
  }

  async healthCheck(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch { return false; }
  }
}

// --- Netlify (stub — ready for future use) ---

export class NetlifyAdapter implements HostingAdapter {
  readonly provider = 'netlify' as const;

  async deploy(token: string, cwd: string, meta?: { commitHash?: string }): Promise<{ url: string; success: boolean; error?: string }> {
    const { execSync } = await import('node:child_process');
    try {
      const output = execSync(`netlify deploy --prod --auth ${token} --dir .next`, {
        cwd, timeout: 180_000, stdio: 'pipe', encoding: 'utf-8', windowsHide: true,
      });
      const urlMatch = output.match(/https:\/\/[^\s]+\.netlify\.app/);
      const url = urlMatch?.[0] || '';
      return { url, success: true };
    } catch (err: any) {
      const error = err.stderr?.toString()?.slice(0, 200) || err.message;
      return { url: '', success: false, error };
    }
  }

  async healthCheck(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch { return false; }
  }
}

// --- Adapter Registry ---

const ADAPTERS: Map<string, HostingAdapter> = new Map();

export function registerHostingAdapter(adapter: HostingAdapter): void {
  ADAPTERS.set(adapter.provider, adapter);
}

export function getHostingAdapter(provider: string): HostingAdapter | null {
  return ADAPTERS.get(provider) || null;
}

// Register built-in adapters
registerHostingAdapter(new VercelAdapter());
registerHostingAdapter(new NetlifyAdapter());
