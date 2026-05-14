import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getConfig } from "./config.js";

const sshSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().default(22),
    user: z.string().min(1),
    auth: z.enum(["password", "key"]),
    password: z.string().optional(),
    privateKeyPath: z.string().optional(),
    passphrase: z.string().optional(),
  })
  .superRefine((ssh, ctx) => {
    if (ssh.auth === "password" && !ssh.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "password is required when auth=password" });
    }
    if (ssh.auth === "key" && !ssh.privateKeyPath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "privateKeyPath is required when auth=key" });
    }
  });

const serverSchema = z.object({
  name: z.string().min(1),
  pveNode: z.string().min(1),
  vmid: z.number().int().positive(),
  kind: z.enum(["lxc", "qemu"]),
  baselineSnapshot: z.string().min(1).default("clean"),
  appPort: z.number().int().positive().optional(),
  healthPath: z.string().optional(),
  ssh: sshSchema,
});

const inventorySchema = z.object({
  servers: z.array(serverSchema).min(1, "at least one server is required"),
  warmTargets: z.array(z.string()).default([]),
});

export type ServerSsh = z.infer<typeof sshSchema>;
export type ServerEntry = z.infer<typeof serverSchema>;
export type Inventory = z.infer<typeof inventorySchema>;

/** Server fields safe to expose to the browser (no secrets). */
export type PublicServer = {
  name: string;
  kind: ServerEntry["kind"];
  appPort?: number;
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveInventoryPath(): string {
  const cfg = getConfig();
  if (cfg.SERVERS_FILE) return resolve(cfg.SERVERS_FILE);
  const local = resolve("config/servers.local.yml");
  if (existsSync(local)) return local;
  return resolve("config/servers.yml");
}

let cached: Inventory | null = null;

export function getInventory(): Inventory {
  if (cached) return cached;
  const path = resolveInventoryPath();
  if (!existsSync(path)) {
    throw new Error(`Server inventory file not found: ${path}`);
  }
  const raw = parseYaml(readFileSync(path, "utf8"));
  const parsed = inventorySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server inventory (${path}):\n${issues}`);
  }
  const names = new Set<string>();
  for (const s of parsed.data.servers) {
    if (names.has(s.name)) throw new Error(`Duplicate server name in inventory: ${s.name}`);
    names.add(s.name);
  }
  for (const w of parsed.data.warmTargets) {
    if (!names.has(w)) throw new Error(`warmTargets references unknown server: ${w}`);
  }
  cached = parsed.data;
  return cached;
}

export function getServer(name: string): ServerEntry {
  const server = getInventory().servers.find((s) => s.name === name);
  if (!server) throw new Error(`Unknown server: ${name}`);
  return server;
}

export function listPublicServers(): PublicServer[] {
  return getInventory().servers.map((s) => ({
    name: s.name,
    kind: s.kind,
    appPort: s.appPort,
  }));
}

export function resolvePrivateKeyPath(p: string): string {
  return resolve(expandHome(p));
}
