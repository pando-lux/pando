/**
 * GitHub Client — Create and manage repos via GitHub API.
 *
 * Used for agent-driven repo creation (Phase 5 of Unified Pipeline).
 * Agents create repos autonomously using contributed PAT credentials.
 */

export interface CreateRepoOptions {
  private?: boolean;
  org?: string;
  description?: string;
  autoInit?: boolean;
}

export interface RepoInfo {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
}

export class GitHubClient {
  private readonly pat: string;
  private readonly apiBase = 'https://api.github.com';

  constructor(pat: string) {
    this.pat = pat;
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Create a new GitHub repository.
   * Returns the repo info including clone URL.
   */
  async createRepo(name: string, opts?: CreateRepoOptions): Promise<RepoInfo> {
    const body: any = {
      name,
      private: opts?.private ?? false,
      auto_init: opts?.autoInit ?? true,
    };
    if (opts?.description) body.description = opts.description;

    const path = opts?.org ? `/orgs/${opts.org}/repos` : '/user/repos';
    const data = await this.request('POST', path, body);

    return {
      fullName: data.full_name,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      private: data.private,
    };
  }

  /** Delete a repository. Requires delete_repo scope on the PAT. */
  async deleteRepo(owner: string, name: string): Promise<void> {
    await this.request('DELETE', `/repos/${owner}/${name}`);
  }

  /** Check if a repository exists. */
  async repoExists(owner: string, name: string): Promise<boolean> {
    try {
      await this.request('GET', `/repos/${owner}/${name}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Get authenticated user info (useful for determining default org). */
  async getAuthenticatedUser(): Promise<{ login: string; name?: string }> {
    return this.request('GET', '/user');
  }
}
