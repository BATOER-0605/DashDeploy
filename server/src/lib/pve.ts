import { Agent } from "undici";

export type GuestKind = "lxc" | "qemu";

export interface PveClientOptions {
  /**
   * One or more PVE node hostnames/IPs. In a cluster, a request to any node is
   * proxied to the node that owns the guest, so a single host is enough;
   * additional hosts act as connection failover targets.
   */
  hosts: string[];
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
  private readonly bases: string[];
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher?: Agent;
  private readonly pollIntervalMs: number;
  private readonly taskTimeoutMs: number;

  constructor(opts: PveClientOptions) {
    if (opts.hosts.length === 0) {
      throw new PveError("PveClient requires at least one host");
    }
    this.bases = opts.hosts.map((h) => `https://${h}:${opts.port}/api2/json`);
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
    // Try each configured host in turn. An HTTP error response is final
    // (the host is reachable, the request is just rejected), but a connection
    // failure falls through to the next host — cluster failover.
    let lastError: unknown;
    for (const base of this.bases) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${base}${path}`, init);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new PveError(
          `PVE ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`,
        );
      }
      const json = (await res.json()) as { data: T };
      return json.data;
    }
    throw new PveError(
      `PVE ${method} ${path} failed: no host reachable (tried ${this.bases.length}): ${String(lastError)}`,
    );
  }

  getStatus(node: string, kind: GuestKind, vmid: number): Promise<GuestStatus> {
    return this.request<GuestStatus>("GET", `/nodes/${node}/${kind}/${vmid}/status/current`);
  }

  start(node: string, kind: GuestKind, vmid: number): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/${kind}/${vmid}/status/start`);
  }

  /** Power off the guest (hard stop). Used before a cold snapshot rollback. */
  stop(node: string, kind: GuestKind, vmid: number): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/${kind}/${vmid}/status/stop`);
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

  // --- Cluster / node inventory ---

  listNodes(): Promise<{ node: string; status: string }[]> {
    return this.request("GET", `/nodes`);
  }

  async listGuests(node: string): Promise<
    {
      kind: GuestKind;
      vmid: number;
      name?: string;
      status: string;
      cpus?: number;
      maxmem?: number;
    }[]
  > {
    const [lxc, qemu] = await Promise.all([
      this.request<Record<string, unknown>[]>("GET", `/nodes/${node}/lxc`),
      this.request<Record<string, unknown>[]>("GET", `/nodes/${node}/qemu`),
    ]);
    const mapRow = (kind: GuestKind) => (g: Record<string, unknown>) => ({
      kind,
      vmid: Number(g.vmid),
      name: (g.name as string | undefined) ?? (g.hostname as string | undefined),
      status: String(g.status ?? ""),
      cpus: g.cpus as number | undefined,
      maxmem: g.maxmem as number | undefined,
    });
    return [...lxc.map(mapRow("lxc")), ...qemu.map(mapRow("qemu"))].sort(
      (a, b) => a.vmid - b.vmid,
    );
  }

  listStorage(
    node: string,
    content?: string,
  ): Promise<{ storage: string; content: string; type: string }[]> {
    const query = content ? `?content=${encodeURIComponent(content)}` : "";
    return this.request("GET", `/nodes/${node}/storage${query}`);
  }

  listStorageContent(
    node: string,
    storage: string,
    content?: string,
  ): Promise<{ volid: string; content: string; size: number }[]> {
    const query = content ? `?content=${encodeURIComponent(content)}` : "";
    return this.request(
      "GET",
      `/nodes/${node}/storage/${encodeURIComponent(storage)}/content${query}`,
    );
  }

  /** List downloadable templates from the Proxmox appliance catalog (pveam). */
  listAvailableTemplates(
    node: string,
  ): Promise<
    {
      template: string;
      package?: string;
      section?: string;
      os?: string;
      version?: string;
      description?: string;
    }[]
  > {
    return this.request("GET", `/nodes/${node}/aplinfo`);
  }

  /** Download a template into a storage (returns a UPID). */
  downloadTemplate(node: string, storage: string, template: string): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/aplinfo`, {
      storage,
      template,
    });
  }

  // --- Mutations ---

  createLxc(
    node: string,
    params: Record<string, string | number>,
  ): Promise<string> {
    return this.request<string>("POST", `/nodes/${node}/lxc`, params);
  }

  deleteGuest(node: string, kind: GuestKind, vmid: number): Promise<string> {
    return this.request<string>("DELETE", `/nodes/${node}/${kind}/${vmid}`);
  }

  updateGuestConfig(
    node: string,
    kind: GuestKind,
    vmid: number,
    config: Record<string, string | number>,
  ): Promise<void> {
    // PUT for lxc, POST for qemu config.
    const method = kind === "qemu" ? "POST" : "PUT";
    return this.request<void>(method, `/nodes/${node}/${kind}/${vmid}/config`, config);
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
