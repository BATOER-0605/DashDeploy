export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

export interface Server {
  name: string;
  kind: "lxc" | "qemu";
  appPort?: number;
}

export interface Deployment {
  id: number;
  repo_full_name: string;
  branch: string;
  server_name: string;
  status: "queued" | "running" | "success" | "failed" | "restored";
  pre_snapshot_name: string | null;
  tailscale_ip: string | null;
  app_port: number | null;
  app_url: string | null;
  health: "healthy" | "unhealthy" | "unknown" | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface LogLine {
  id: number;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async listRepos(): Promise<Repo[]> {
    const { repos } = await json<{ repos: Repo[] }>(await fetch("/api/repos"));
    return repos;
  },
  async listBranches(repoFullName: string): Promise<string[]> {
    const { branches } = await json<{ branches: string[] }>(
      await fetch(`/api/repos/${repoFullName}/branches`),
    );
    return branches;
  },
  async listServers(): Promise<Server[]> {
    const { servers } = await json<{ servers: Server[] }>(await fetch("/api/servers"));
    return servers;
  },
  async listDeployments(): Promise<Deployment[]> {
    const { deployments } = await json<{ deployments: Deployment[] }>(
      await fetch("/api/deployments"),
    );
    return deployments;
  },
  async startDeploy(input: {
    repoFullName: string;
    branch: string;
    serverName: string;
    takePreSnapshot: boolean;
  }): Promise<number> {
    const { deploymentId } = await json<{ deploymentId: number }>(
      await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return deploymentId;
  },
  async restore(deploymentId: number): Promise<void> {
    await json(
      await fetch(`/api/deployments/${deploymentId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  },
  async pruneHistory(): Promise<number> {
    const { deleted } = await json<{ deleted: number }>(
      await fetch("/api/deployments/prune", { method: "POST" }),
    );
    return deleted;
  },
};

/**
 * Subscribe to a deployment's log stream. Returns a cleanup function.
 * `onDone` receives the final deployment record.
 */
export function streamDeployLogs(
  deploymentId: number,
  onLog: (line: LogLine) => void,
  onDone: (deployment: Deployment) => void,
): () => void {
  const es = new EventSource(`/api/deploy/${deploymentId}/logs`);
  es.addEventListener("log", (e) => onLog(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("done", (e) => {
    onDone(JSON.parse((e as MessageEvent).data));
    es.close();
  });
  es.onerror = () => es.close();
  return () => es.close();
}
