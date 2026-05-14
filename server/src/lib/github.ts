const API = "https://api.github.com";

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

export class GithubError extends Error {}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DashDeploy",
  };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function getJson<T>(url: string, pat: string): Promise<{ body: T; res: Response }> {
  const res = await fetch(url, { headers: headers(pat) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubError(`GitHub ${url} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return { body: (await res.json()) as T, res };
}

interface RawRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

export async function listRepos(pat: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  let url: string | null = `${API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
  while (url) {
    const { body, res }: { body: RawRepo[]; res: Response } = await getJson<RawRepo[]>(url, pat);
    for (const r of body) {
      repos.push({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        updatedAt: r.updated_at,
      });
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return repos;
}

export async function listBranches(
  pat: string,
  owner: string,
  repo: string,
): Promise<string[]> {
  const branches: string[] = [];
  let url: string | null = `${API}/repos/${owner}/${repo}/branches?per_page=100`;
  while (url) {
    const { body, res }: { body: { name: string }[]; res: Response } = await getJson<
      { name: string }[]
    >(url, pat);
    for (const b of body) branches.push(b.name);
    url = parseNextLink(res.headers.get("link"));
  }
  return branches;
}

/** Verify the PAT works (used by the health check). */
export async function verifyPat(pat: string): Promise<string> {
  const { body } = await getJson<{ login: string }>(`${API}/user`, pat);
  return body.login;
}

/** Build a clone URL that embeds the PAT for cloning private repos on the target. */
export function cloneUrl(pat: string, repoFullName: string): string {
  return `https://x-access-token:${pat}@github.com/${repoFullName}.git`;
}
