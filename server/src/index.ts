import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { FastifySSEPlugin } from "fastify-sse-v2";
import { getConfig } from "./config.js";
import { getInventory } from "./inventory.js";
import { getDb } from "./db/client.js";
import { repoRoutes } from "./routes/repos.js";
import { serverRoutes } from "./routes/servers.js";
import { deployRoutes } from "./routes/deploy.js";
import { restoreRoutes } from "./routes/restore.js";
import { historyRoutes } from "./routes/history.js";
import { healthRoutes } from "./routes/health.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  // Fail fast on a malformed inventory and apply DB migrations on boot.
  getInventory();
  getDb();

  const app = Fastify({ logger: true });

  await app.register(FastifySSEPlugin);
  await app.register(repoRoutes);
  await app.register(serverRoutes);
  await app.register(deployRoutes);
  await app.register(restoreRoutes);
  await app.register(historyRoutes);
  await app.register(healthRoutes);

  // Serve the built SPA in production. In dev the frontend runs under Vite.
  const webDist = resolve("web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  await app.listen({ host: cfg.BIND_HOST, port: cfg.PORT });
  app.log.info(`DashDeploy listening on ${cfg.BIND_HOST}:${cfg.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
