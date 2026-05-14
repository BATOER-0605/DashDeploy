import { Agent } from "undici";

export type GuestKind = "lxc" | "qemu";

export interface PveClientOptions {
  host: string;
  port: number;
  tokenId: string;
  tokenSecret: string;
  rejectUnauthorized: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Task poll interval in ms. */
  pollIntervalMs?: number;
  /** Task wait timeout in ms. */
  taskTimeoutMs?: number;
}

export interface GuestStatus {
  status: "running" | "stopped" | string;
  name?: string;
}

export interface PveSnapshot {
  name: string;
  description?: string;
  snaptime?: number;
}

export class PveError extends Error {}

export class PveClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher?: Agent;
  private readonly pollIntervalMs: number;
  private readonly taskTimeoutMs: number;

  constructor(opts: PveClientOptions) {
    this.base = `https://${opts.host}:${opts.port}/api2/json`;
    this.authHeader = `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 5 * 60 * 1000;
    // Homelab PVE typically uses a self-signed cert.
    if (!opts.rejectUnauthorized && !opts.fetchImpl) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, string | number>,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.authHeader };
    const init: RequestInit = { method, headers };
    // Node's fetch accepts an undici `dispatcher`; the type is not in the
    // standard RequestInit, so attach it untyped.
    if (this.dispatcher) {
      (init as { dispatcher?: unknown }).dispatcher = this.dispatcher;
    }
    if (body) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) form.append(k, String(v));
      init.body = form;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PveError(`PVE ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`);
    }
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  getStatus(node: string, kind: GuestKind, vmid: number): Promise<GuestStatus> {
    return this.request<GuestStatus>("GET", `/nodes/${node}/${kind}/${vmid}/status/current`);
  }

  start(node: string, kind: GuestKind, vmid: number): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/${kind}/${vmid}/status/start`);
  }

  listSnapshots(node: string, kind: GuestKind, vmid: number): Promise<PveSnapshot[]> {
    return this.request<PveSnapshot[]>("GET", `/nodes/${node}/${kind}/${vmid}/snapshot`);
  }

  createSnapshot(
    node: string,
    kind: GuestKind,
    vmid: number,
    snapname: string,
    description = "DashDeploy pre-deploy snapshot",
  ): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/${kind}/${vmid}/snapshot`, {
      snapname,
      description,
    });
  }

  rollback(node: string, kind: GuestKind, vmid: number, snapname: string): Promise<string> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/${kind}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`,
    );
  }

  getTaskStatus(
    node: string,
    upid: string,
  ): Promise<{ status: string; exitstatus?: string }> {
    return this.request("GET", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
  }

  /**
   * Poll a PVE task (identified by UPID) until it finishes.
   * Throws PveError if the task exits with a non-OK status or times out.
   */
  async waitForTask(
    node: string,
    upid: string,
    onProgress?: (status: string) => void,
  ): Promise<void> {
    const deadline = Date.now() + this.taskTimeoutMs;
    for (;;) {
      const task = await this.getTaskStatus(node, upid);
      if (task.status === "stopped") {
        if (task.exitstatus && task.exitstatus !== "OK") {
          throw new PveError(`PVE task ${upid} failed: ${task.exitstatus}`);
        }
        return;
      }
      onProgress?.(task.status);
      if (Date.now() > deadline) {
        throw new PveError(`PVE task ${upid} timed out after ${this.taskTimeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
