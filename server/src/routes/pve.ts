import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPveClient } from "../services/clients.js";
import type { GuestKind } from "../lib/pve.js";

const kindSchema = z.enum(["lxc", "qemu"]);

const createLxcSchema = z.object({
  node: z.string().min(1),
  vmid: z.number().int().positive(),
  ostemplate: z.string().min(1), // e.g. local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst
  hostname: z.string().min(1).optional(),
  cores: z.number().int().positive().default(1),
  memory: z.number().int().positive().default(512), // MB
  storage: z.string().min(1).default("local-lvm"),
  diskSize: z.number().int().positive().default(8), // GB
  password: z.string().min(5).optional(),
  sshPublicKey: z.string().optional(),
  bridge: z.string().default("vmbr0"),
  ipConfig: z.string().default("dhcp"), // "dhcp" or "ip=1.2.3.4/24,gw=1.2.3.1"
  unprivileged: z.boolean().default(true),
  start: z.boolean().default(false),
});

const updateConfigSchema = z.object({
  cores: z.number().int().positive().optional(),
  memory: z.number().int().positive().optional(), // MB
});

export async function pveRoutes(app: FastifyInstance): Promise<void> {
  const pve = () => getPveClient();

  app.get("/api/pve/nodes", async () => ({ nodes: await pve().listNodes() }));

  app.get<{ Params: { node: string } }>("/api/pve/nodes/:node/guests", async (req) => ({
    guests: await pve().listGuests(req.params.node),
  }));

  app.get<{ Params: { node: string }; Querystring: { content?: string } }>(
    "/api/pve/nodes/:node/storage",
    async (req) => ({
      storage: await pve().listStorage(req.params.node, req.query.content),
    }),
  );

  app.get<{
    Params: { node: string; storage: string };
    Querystring: { content?: string };
  }>("/api/pve/nodes/:node/storage/:storage/content", async (req) => ({
    content: await pve().listStorageContent(
      req.params.node,
      req.params.storage,
      req.query.content,
    ),
  }));

  // List downloadable templates from the Proxmox appliance catalog.
  app.get<{ Params: { node: string } }>(
    "/api/pve/nodes/:node/templates/available",
    async (req) => ({
      templates: await pve().listAvailableTemplates(req.params.node),
    }),
  );

  // Download a template into the given storage (sync, waits for completion).
  const downloadTemplateSchema = z.object({
    node: z.string().min(1),
    storage: z.string().min(1),
    template: z.string().min(1),
  });
  app.post("/api/pve/templates/download", async (req, reply) => {
    const parsed = downloadTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request", issues: parsed.error.issues };
    }
    const { node, storage, template } = parsed.data;
    try {
      const upid = await pve().downloadTemplate(node, storage, template);
      await pve().waitForTask(node, upid);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  // Create an LXC container.
  app.post("/api/pve/lxc", async (req, reply) => {
    const parsed = createLxcSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request", issues: parsed.error.issues };
    }
    const p = parsed.data;
    const params: Record<string, string | number> = {
      vmid: p.vmid,
      ostemplate: p.ostemplate,
      cores: p.cores,
      memory: p.memory,
      rootfs: `${p.storage}:${p.diskSize}`,
      net0:
        p.ipConfig === "dhcp"
          ? `name=eth0,bridge=${p.bridge},ip=dhcp`
          : `name=eth0,bridge=${p.bridge},${p.ipConfig}`,
      unprivileged: p.unprivileged ? 1 : 0,
      start: p.start ? 1 : 0,
    };
    if (p.hostname) params.hostname = p.hostname;
    if (p.password) params.password = p.password;
    if (p.sshPublicKey) params["ssh-public-keys"] = p.sshPublicKey;
    try {
      const upid = await pve().createLxc(p.node, params);
      await pve().waitForTask(p.node, upid);
      return { ok: true, vmid: p.vmid };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  // Delete a guest (must be stopped first).
  app.delete<{
    Params: { node: string; kind: string; vmid: string };
  }>("/api/pve/guests/:node/:kind/:vmid", async (req, reply) => {
    const kind = kindSchema.safeParse(req.params.kind);
    if (!kind.success) {
      reply.code(400);
      return { error: "kind must be lxc or qemu" };
    }
    const vmid = Number(req.params.vmid);
    try {
      // If the guest is running, stop it first.
      const status = await pve().getStatus(req.params.node, kind.data, vmid);
      if (status.status !== "stopped") {
        const stopUpid = await pve().stop(req.params.node, kind.data, vmid);
        await pve().waitForTask(req.params.node, stopUpid);
      }
      const upid = await pve().deleteGuest(req.params.node, kind.data as GuestKind, vmid);
      await pve().waitForTask(req.params.node, upid);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  // Update cores / memory.
  app.put<{
    Params: { node: string; kind: string; vmid: string };
  }>("/api/pve/guests/:node/:kind/:vmid/config", async (req, reply) => {
    const kind = kindSchema.safeParse(req.params.kind);
    if (!kind.success) {
      reply.code(400);
      return { error: "kind must be lxc or qemu" };
    }
    const parsed = updateConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request", issues: parsed.error.issues };
    }
    const config: Record<string, string | number> = {};
    if (parsed.data.cores) config.cores = parsed.data.cores;
    if (parsed.data.memory) config.memory = parsed.data.memory;
    if (Object.keys(config).length === 0) {
      reply.code(400);
      return { error: "no fields to update" };
    }
    try {
      await pve().updateGuestConfig(
        req.params.node,
        kind.data as GuestKind,
        Number(req.params.vmid),
        config,
      );
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });
}
