import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";
import { listBranches, listRepos } from "../lib/github.js";

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/repos", async () => {
    const repos = await listRepos(getConfig().GITHUB_PAT);
    return { repos };
  });

  app.get<{ Params: { owner: string; repo: string } }>(
    "/api/repos/:owner/:repo/branches",
    async (req) => {
      const { owner, repo } = req.params;
      const branches = await listBranches(getConfig().GITHUB_PAT, owner, repo);
      return { branches };
    },
  );
}
