import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { listDevices } from "../lib/tailscale.js";

export async function tailscaleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tailscale/devices", async (_req, reply) => {
    const cfg = getConfig();
    if (!cfg.TAILSCALE_API_KEY || !cfg.TAILSCALE_TAILNET) {
      reply.code(400);
      return {
        error:
          "TAILSCALE_API_KEY と TAILSCALE_TAILNET を .env に設定してください。",
      };
    }
    try {
      const devices = await listDevices(cfg.TAILSCALE_API_KEY, cfg.TAILSCALE_TAILNET);
      return { devices };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });
}
