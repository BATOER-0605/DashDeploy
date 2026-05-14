import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createDeployment, getDeployment, getEvents } from "../db/deployments.js";
import { getInventory } from "../inventory.js";
import { logbus, type LogLine } from "../lib/logbus.js";
import { runDeployment } from "../services/deploy.js";

const deployBodySchema = z.object({
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
  serverName: z.string().min(1),
  takePreSnapshot: z.boolean().default(false),
});

type SseEvent = { event: string; data: string };

/**
 * Yields persisted log lines for replay, then live lines via logbus,
 * and finally a terminal `done` event with the deployment record.
 */
async function* streamLogs(id: number): AsyncGenerator<SseEvent> {
  // Subscribe first so no live line is missed between replay and subscription.
  const queue: LogLine[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const offLine = logbus.onLine(id, (line) => {
    queue.push(line);
    wake?.();
  });
  const offDone = logbus.onDone(id, () => {
    finished = true;
    wake?.();
  });

  try {
    // Replay persisted events.
    let maxReplayedId = 0;
    for (const e of getEvents(id)) {
      maxReplayedId = e.id;
      yield { event: "log", data: JSON.stringify(e) };
    }

    const current = getDeployment(id);
    if (current && ["success", "failed", "restored"].includes(current.status)) {
      yield { event: "done", data: JSON.stringify(current) };
      return;
    }

    // Stream live lines, skipping any already covered by the replay.
    for (;;) {
      while (queue.length > 0) {
        const line = queue.shift()!;
        if (line.id > maxReplayedId) {
          maxReplayedId = line.id;
          yield { event: "log", data: JSON.stringify(line) };
        }
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    yield { event: "done", data: JSON.stringify(getDeployment(id)) };
  } finally {
    offLine();
    offDone();
  }
}

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/deploy", async (req, reply) => {
    const parsed = deployBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request", issues: parsed.error.issues };
    }
    const { repoFullName, branch, serverName, takePreSnapshot } = parsed.data;

    if (!getInventory().servers.some((s) => s.name === serverName)) {
      reply.code(400);
      return { error: `unknown server: ${serverName}` };
    }

    const deployment = createDeployment({ repoFullName, branch, serverName });
    // Run detached — the client follows progress over the SSE stream.
    void runDeployment(deployment.id, { takePreSnapshot }).catch((err) => {
      app.log.error(err, "runDeployment crashed");
    });

    reply.code(202);
    return { deploymentId: deployment.id };
  });

  app.get<{ Params: { id: string } }>("/api/deploy/:id/logs", async (req, reply) => {
    const id = Number(req.params.id);
    if (!getDeployment(id)) {
      reply.code(404);
      return { error: "deployment not found" };
    }
    reply.sse(streamLogs(id));
  });
}
