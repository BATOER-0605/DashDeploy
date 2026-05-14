import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDeployment } from "../db/deployments.js";
import { restoreDeployment } from "../services/deploy.js";

const restoreBodySchema = z
  .object({ snapshot: z.string().min(1).optional() })
  .default({});

export async function restoreRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/restore",
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!getDeployment(id)) {
        reply.code(404);
        return { error: "deployment not found" };
      }
      const parsed = restoreBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid request", issues: parsed.error.issues };
      }
      try {
        const result = await restoreDeployment(id, parsed.data.snapshot);
        return { ok: true, ...result };
      } catch (err) {
        reply.code(500);
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
