import { getConfig } from "../config.js";
import { PveClient } from "../lib/pve.js";

let pve: PveClient | null = null;

export function getPveClient(): PveClient {
  if (pve) return pve;
  const cfg = getConfig();
  pve = new PveClient({
    // PVE_HOST may be a comma-separated list — one node is enough for a
    // cluster, extra entries are failover targets.
    hosts: cfg.PVE_HOST.split(",").map((h) => h.trim()).filter(Boolean),
    port: cfg.PVE_PORT,
    tokenId: cfg.PVE_TOKEN_ID,
    tokenSecret: cfg.PVE_TOKEN_SECRET,
    rejectUnauthorized: cfg.PVE_TLS_REJECT_UNAUTHORIZED,
  });
  return pve;
}

/** Drop the cached PveClient so the next call rebuilds it with fresh config. */
export function resetPveClient(): void {
  pve = null;
}
