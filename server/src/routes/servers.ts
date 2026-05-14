import type { FastifyInstance } from "fastify";
import { listPublicServers } from "../inventory.js";

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/servers", async () => {
    return { servers: listPublicServers() };
  });
}
