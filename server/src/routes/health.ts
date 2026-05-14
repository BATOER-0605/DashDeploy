import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { verifyPat } from "../lib/github.js";
import { getInventory } from "../inventory.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    const result: {
      ok: boolean;
      github: { ok: boolean; login?: string; error?: string };
      inventory: { ok: boolean; servers?: number; error?: string };
    } = {
      ok: true,
      github: { ok: false },
      inventory: { ok: false },
    };

    try {
      result.github = { ok: true, login: await verifyPat(getConfig().GITHUB_PAT) };
    } catch (err) {
      result.github = { ok: false, error: (err as Error).message };
      result.ok = false;
    }

    try {
      result.inventory = { ok: true, servers: getInventory().servers.length };
    } catch (err) {
      result.inventory = { ok: false, error: (err as Error).message };
      result.ok = false;
    }

    return result;
  });
}
