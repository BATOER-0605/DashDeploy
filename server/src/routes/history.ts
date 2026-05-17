import type { FastifyInstance } from "fastify";
import {
  getDeployment,
  getEvents,
  listDeployments,
  pruneInactiveDeployments,
} from "../db/deployments.js";

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/deployments", async () => {
    return { deployments: listDeployments(100) };
  });

  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const deployment = getDeployment(id);
    if (!deployment) {
      reply.code(404);
      return { error: "deployment not found" };
    }
    return { deployment, events: getEvents(id) };
  });

  // Bulk delete: removes deployments whose status is failed/restored/queued.
  app.post("/api/deployments/prune", async () => {
    const deleted = pruneInactiveDeployments();
    return { deleted };
  });
}
