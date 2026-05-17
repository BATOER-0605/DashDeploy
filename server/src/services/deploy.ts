import { parse as parseYaml } from "yaml";
import { getConfig } from "../config.js";
import { getServer, type ServerEntry } from "../inventory.js";
import { cloneUrl } from "../lib/github.js";
import { logbus } from "../lib/logbus.js";
import { captureCommand, runCommand } from "../lib/ssh.js";
import {
  getDeployment,
  updateDeployment,
  type Deployment,
  type LogStream,
} from "../db/deployments.js";
import { getPveClient } from "./clients.js";

const APP_DIR = "~/dashdeploy/app";

interface DashDeployFile {
  build?: string;
  appPort?: number;
  healthPath?: string;
}

/** Remove the PAT from a log line before it is persisted or streamed. */
function makeScrubber(pat: string) {
  return (line: string): string => (pat ? line.split(pat).join("***") : line);
}

function publish(
  deploymentId: number,
  scrub: (l: string) => string,
  stream: LogStream,
  line: string,
): void {
  logbus.publish(deploymentId, stream, scrub(line));
}

const SUDO_PRELUDE = 'if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi';

function ensureDockerScript(): string {
  // Idempotent: skips installation if docker is already present.
  // Targets only need passwordless sudo (or SSH as root) — no Docker pre-install required.
  return [
    "set -e",
    SUDO_PRELUDE,
    "if ! command -v curl >/dev/null 2>&1; then",
    '  echo "installing curl..."',
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y curl;",
    "  elif command -v dnf >/dev/null 2>&1; then",
    "    $SUDO dnf install -y curl;",
    "  elif command -v yum >/dev/null 2>&1; then",
    "    $SUDO yum install -y curl;",
    "  else",
    '    echo "no supported package manager to install curl" >&2; exit 1;',
    "  fi",
    "fi",
    "if ! command -v docker >/dev/null 2>&1; then",
    '  echo "installing Docker via get.docker.com..."',
    "  curl -fsSL https://get.docker.com | $SUDO sh",
    "else",
    '  echo "docker already installed: $(docker --version)"',
    "fi",
    "$SUDO systemctl enable --now docker >/dev/null 2>&1 || true",
  ].join("\n");
}

function defaultBuildScript(): string {
  return [
    "if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ] || [ -f compose.yaml ]; then",
    "  $SUDO docker compose up -d --build;",
    "elif [ -f Dockerfile ]; then",
    "  $SUDO docker build -t dashdeploy-app .;",
    "  $SUDO docker rm -f dashdeploy-app 2>/dev/null || true;",
    "  $SUDO docker run -d --name dashdeploy-app -P dashdeploy-app;",
    "else",
    '  echo "no Dockerfile or docker-compose file found in repo" >&2; exit 1;',
    "fi",
  ].join("\n");
}

function cloneScript(branch: string, url: string): string {
  // Avoid `set -x` so the PAT-bearing URL is never echoed.
  return [
    "set -e",
    `rm -rf ${APP_DIR}`,
    `mkdir -p ${APP_DIR}`,
    `git clone --depth 1 --branch '${branch}' '${url}' ${APP_DIR}`,
    // Drop the origin remote so the PAT is not left on the target's disk.
    `git -C ${APP_DIR} remote remove origin || true`,
    `echo "clone complete"`,
  ].join("\n");
}

async function readDashDeployFile(server: ServerEntry): Promise<DashDeployFile> {
  const raw = await captureCommand(
    server,
    `cat ${APP_DIR}/.dashdeploy.yml 2>/dev/null || cat ${APP_DIR}/.dashdeploy.yaml 2>/dev/null || true`,
  );
  if (!raw.trim()) return {};
  try {
    const parsed = parseYaml(raw) as DashDeployFile | null;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function pollHealth(url: string, scrub: (l: string) => string, deploymentId: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        publish(deploymentId, scrub, "system", `health check OK (${res.status}) at ${url}`);
        return "healthy" as const;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  publish(deploymentId, scrub, "system", `health check did not succeed within 60s at ${url}`);
  return "unhealthy" as const;
}

/**
 * Orchestrates a full deployment. Runs detached from the HTTP request;
 * all progress is streamed via logbus and persisted to the deployments row.
 */
export async function runDeployment(
  deploymentId: number,
  opts: { takePreSnapshot: boolean },
): Promise<void> {
  const deployment = getDeployment(deploymentId);
  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  const cfg = getConfig();
  const scrub = makeScrubber(cfg.GITHUB_PAT);
  const log = (stream: LogStream, line: string) =>
    publish(deploymentId, scrub, stream, line);

  try {
    updateDeployment(deploymentId, { status: "running" });
    const server = getServer(deployment.server_name);
    const pve = getPveClient();
    const { pveNode, kind, vmid } = server;

    // 1. Ensure the target guest is running.
    log("system", `checking ${kind} ${vmid} on node ${pveNode}...`);
    const status = await pve.getStatus(pveNode, kind, vmid);
    if (status.status !== "running") {
      log("system", `guest is ${status.status}; starting...`);
      const upid = await pve.start(pveNode, kind, vmid);
      await pve.waitForTask(pveNode, upid, (s) => log("system", `start task: ${s}`));
      log("system", "guest started");
    } else {
      log("system", "guest already running");
    }

    // 2. Ensure Docker is installed on the target (idempotent).
    log("system", "ensuring Docker is installed on target...");
    const dockerCode = await runCommand(server, ensureDockerScript(), log);
    if (dockerCode !== 0) throw new Error(`docker setup failed (exit ${dockerCode})`);

    // 3. Optional pre-deploy snapshot.
    if (opts.takePreSnapshot) {
      const snapName = `predeploy-${Date.now()}`;
      log("system", `creating pre-deploy snapshot "${snapName}"...`);
      const upid = await pve.createSnapshot(pveNode, kind, vmid, snapName);
      await pve.waitForTask(pveNode, upid, (s) => log("system", `snapshot task: ${s}`));
      updateDeployment(deploymentId, { pre_snapshot_name: snapName });
      log("system", "pre-deploy snapshot created");
    }

    // 3. Clone the repo on the target.
    log("system", `cloning ${deployment.repo_full_name}#${deployment.branch}...`);
    const url = cloneUrl(cfg.GITHUB_PAT, deployment.repo_full_name);
    const cloneCode = await runCommand(server, cloneScript(deployment.branch, url), log);
    if (cloneCode !== 0) throw new Error(`git clone failed (exit ${cloneCode})`);

    // 4. Read optional .dashdeploy.yml overrides.
    const ddf = await readDashDeployFile(server);
    const buildCmd = ddf.build ?? defaultBuildScript();

    // 5. Build & run with Docker. $SUDO is set by the prelude so build commands
    //    work the same whether the SSH user is root or has passwordless sudo.
    log("system", "building and starting containers...");
    const buildScript = `set -e\n${SUDO_PRELUDE}\ncd ${APP_DIR}\n${buildCmd}`;
    const buildCode = await runCommand(server, buildScript, log);
    if (buildCode !== 0) throw new Error(`docker build/run failed (exit ${buildCode})`);

    // 6. Resolve the Tailscale IP of the target.
    let tailscaleIp: string | null = null;
    try {
      tailscaleIp = await captureCommand(server, "tailscale ip -4");
      tailscaleIp = tailscaleIp.split("\n")[0]?.trim() || null;
      log("system", `Tailscale IP: ${tailscaleIp ?? "unavailable"}`);
    } catch (err) {
      log("stderr", `could not get Tailscale IP: ${(err as Error).message}`);
    }

    // 7. Compute the app URL and run a health check.
    const appPort = ddf.appPort ?? server.appPort ?? null;
    const healthPath = ddf.healthPath ?? server.healthPath ?? "/";
    let appUrl: string | null = null;
    let health: Deployment["health"] = "unknown";
    if (tailscaleIp && appPort) {
      appUrl = `http://${tailscaleIp}:${appPort}`;
      health = await pollHealth(`${appUrl}${healthPath}`, scrub, deploymentId);
    }

    updateDeployment(deploymentId, {
      status: "success",
      tailscale_ip: tailscaleIp,
      app_port: appPort,
      app_url: appUrl,
      health,
      finished_at: new Date().toISOString(),
    });
    log("system", "deployment finished successfully");
  } catch (err) {
    const message = makeScrubber(cfg.GITHUB_PAT)((err as Error).message);
    logbus.publish(deploymentId, "stderr", `deployment failed: ${message}`);
    updateDeployment(deploymentId, {
      status: "failed",
      error: message,
      finished_at: new Date().toISOString(),
    });
  } finally {
    logbus.finish(deploymentId);
  }
}

/** Roll the target back to a snapshot (defaults to the server's baseline). */
export async function restoreDeployment(
  deploymentId: number,
  snapshot?: string,
): Promise<{ snapshot: string }> {
  const deployment = getDeployment(deploymentId);
  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  const server = getServer(deployment.server_name);
  const target = snapshot ?? server.baselineSnapshot;
  const pve = getPveClient();
  const log = (stream: LogStream, line: string) => logbus.publish(deploymentId, stream, line);

  log("system", `restoring ${server.kind} ${server.vmid} to snapshot "${target}"...`);
  try {
    // Cold restore: power the guest off first, then roll back the snapshot.
    const status = await pve.getStatus(server.pveNode, server.kind, server.vmid);
    if (status.status !== "stopped") {
      log("system", "powering off guest before rollback...");
      const stopUpid = await pve.stop(server.pveNode, server.kind, server.vmid);
      await pve.waitForTask(server.pveNode, stopUpid, (s) => log("system", `stop task: ${s}`));
      log("system", "guest powered off");
    }
    const upid = await pve.rollback(server.pveNode, server.kind, server.vmid, target);
    await pve.waitForTask(server.pveNode, upid, (s) => log("system", `rollback task: ${s}`));
    updateDeployment(deploymentId, { status: "restored" });
    log("system", `restore complete (snapshot "${target}")`);
    return { snapshot: target };
  } catch (err) {
    const message = (err as Error).message;
    log("stderr", `restore failed: ${message}`);
    throw err;
  }
}
