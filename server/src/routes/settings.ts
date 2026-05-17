import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { reloadConfig } from "../config.js";
import { getInventory, reloadInventory } from "../inventory.js";
import { resetPveClient } from "../services/clients.js";

const ENV_PATH = resolve(".env");
const SERVERS_LOCAL = resolve("config/servers.local.yml");
const SERVERS_SAMPLE = resolve("config/servers.yml");

const ALLOWED_ENV_KEYS = [
  "GITHUB_PAT",
  "PVE_HOST",
  "PVE_PORT",
  "PVE_TOKEN_ID",
  "PVE_TOKEN_SECRET",
  "PVE_TLS_REJECT_UNAUTHORIZED",
  "BIND_HOST",
  "PORT",
  "TAILSCALE_API_KEY",
  "TAILSCALE_TAILNET",
] as const;

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function formatEnvFile(values: Record<string, string>): string {
  return (
    ALLOWED_ENV_KEYS.filter((k) => values[k] !== undefined && values[k] !== "")
      .map((k) => `${k}=${values[k]}`)
      .join("\n") + "\n"
  );
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // --- .env ---
  app.get("/api/settings/env", async () => {
    if (!existsSync(ENV_PATH)) return { values: {}, keys: ALLOWED_ENV_KEYS };
    const content = await readFile(ENV_PATH, "utf8");
    return { values: parseEnvFile(content), keys: ALLOWED_ENV_KEYS };
  });

  app.post<{ Body: { values?: Record<string, string> } }>(
    "/api/settings/env",
    async (req, reply) => {
      const body = req.body;
      if (!body?.values || typeof body.values !== "object") {
        reply.code(400);
        return { error: "expected { values: { KEY: VALUE } }" };
      }
      const filtered: Record<string, string> = {};
      for (const k of ALLOWED_ENV_KEYS) {
        const v = body.values[k];
        if (typeof v === "string") filtered[k] = v;
      }
      await writeFile(ENV_PATH, formatEnvFile(filtered), { mode: 0o600 });
      return { ok: true };
    },
  );

  // --- servers.local.yml ---
  app.get("/api/settings/servers", async () => {
    const path = existsSync(SERVERS_LOCAL) ? SERVERS_LOCAL : SERVERS_SAMPLE;
    const yaml = existsSync(path) ? await readFile(path, "utf8") : "";
    return { yaml, path };
  });

  app.post<{ Body: { yaml?: string } }>("/api/settings/servers", async (req, reply) => {
    const body = req.body;
    if (typeof body?.yaml !== "string") {
      reply.code(400);
      return { error: "expected { yaml: string }" };
    }
    try {
      parseYaml(body.yaml);
    } catch (err) {
      reply.code(400);
      return { error: `YAML parse error: ${(err as Error).message}` };
    }
    await writeFile(SERVERS_LOCAL, body.yaml, { mode: 0o600 });
    return { ok: true };
  });

  // --- Reload caches so changes take effect without a process restart ---
  app.post("/api/settings/reload", async (_req, reply) => {
    try {
      reloadConfig();
      resetPveClient();
      reloadInventory();
      getInventory(); // re-validate
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });
}
