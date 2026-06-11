import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPveClient } from "../services/clients.js";
import type { GuestKind } from "../lib/pve.js";

const kindSchema = z.enum(["lxc", "qemu"]);

const cloneGuestSchema = z.object({
  node: z.string().min(1),
  sourceKind: kindSchema,
  sourceVmid: z.number().int().positive(),
  newVmid: z.number().int().positive(),
  name: z.string().min(1),
  full: z.boolean().default(false),
  storage: z.string().min(1).optional(),
  description: z.string().optional(),
  start: z.boolean().default(true),
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

  // List template-ized guests (lxc + qemu) on the node — these are the only
  // valid clone sources in the redesigned create flow.
  app.get<{ Params: { node: string } }>(
    "/api/pve/nodes/:node/templates/guests",
    async (req) => ({
      templates: await pve().listTemplateGuests(req.params.node),
    }),
  );

  // Suggest the next free vmid (used to prefill the clone form).
  app.get("/api/pve/nextid", async (_req, reply) => {
    try {
      return { vmid: await pve().getNextVmid() };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  // Clone an LXC/VM template into a new guest, optionally starting it.
  // When start=true, also attempts to detect the guest's DHCP IP (best-effort,
  // ~30s window) so the WebUI can pre-fill the inventory SSH host field.
  app.post("/api/pve/clone", async (req, reply) => {
    const parsed = cloneGuestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request", issues: parsed.error.issues };
    }
    const p = parsed.data;
    try {
      const upid = await pve().cloneGuest(p.node, p.sourceKind, p.sourceVmid, {
        newid: p.newVmid,
        name: p.name,
        full: p.full,
        storage: p.storage,
        description: p.description,
      });
      await pve().waitForTask(p.node, upid);
      let detectedIp: string | null = null;
      if (p.start) {
        const startUpid = await pve().start(p.node, p.sourceKind, p.newVmid);
        await pve().waitForTask(p.node, startUpid);
        detectedIp = await pve().waitForGuestIp(p.node, p.sourceKind, p.newVmid);
      }
      return { ok: true, vmid: p.newVmid, kind: p.sourceKind, detectedIp };
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
