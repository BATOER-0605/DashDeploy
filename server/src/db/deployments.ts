import { getDb } from "./client.js";

export type DeploymentStatus = "queued" | "running" | "success" | "failed" | "restored";
export type HealthStatus = "healthy" | "unhealthy" | "unknown";
export type LogStream = "stdout" | "stderr" | "system";

export interface Deployment {
  id: number;
  repo_full_name: string;
  branch: string;
  server_name: string;
  status: DeploymentStatus;
  pre_snapshot_name: string | null;
  tailscale_ip: string | null;
  app_port: number | null;
  app_url: string | null;
  health: HealthStatus | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface DeploymentEvent {
  id: number;
  deployment_id: number;
  ts: string;
  stream: LogStream;
  line: string;
}

export function createDeployment(input: {
  repoFullName: string;
  branch: string;
  serverName: string;
}): Deployment {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO deployments (repo_full_name, branch, server_name, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
    )
    .run(input.repoFullName, input.branch, input.serverName, now);
  return getDeployment(Number(info.lastInsertRowid))!;
}

export function getDeployment(id: number): Deployment | undefined {
  return getDb().prepare(`SELECT * FROM deployments WHERE id = ?`).get(id) as Deployment | undefined;
}

export function listDeployments(limit = 50): Deployment[] {
  return getDb()
    .prepare(`SELECT * FROM deployments ORDER BY id DESC LIMIT ?`)
    .all(limit) as Deployment[];
}

export function updateDeployment(id: number, patch: Partial<Omit<Deployment, "id">>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE deployments SET ${assignments} WHERE id = @id`)
    .run({ ...patch, id });
}

export function appendEvent(deploymentId: number, stream: LogStream, line: string): DeploymentEvent {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO deployment_events (deployment_id, ts, stream, line) VALUES (?, ?, ?, ?)`,
    )
    .run(deploymentId, ts, stream, line);
  return {
    id: Number(info.lastInsertRowid),
    deployment_id: deploymentId,
    ts,
    stream,
    line,
  };
}

export function getEvents(deploymentId: number): DeploymentEvent[] {
  return getDb()
    .prepare(`SELECT * FROM deployment_events WHERE deployment_id = ? ORDER BY id ASC`)
    .all(deploymentId) as DeploymentEvent[];
}

/**
 * Delete deployments that are no longer "currently active" — `failed`,
 * `restored`, and `queued`. `success` (app is up on a target) and `running`
 * (deploy in progress) are preserved. The associated `deployment_events`
 * rows are removed via ON DELETE CASCADE.
 */
export function pruneInactiveDeployments(): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM deployments WHERE status IN ('failed', 'restored', 'queued')`,
    )
    .run();
  return result.changes;
}
