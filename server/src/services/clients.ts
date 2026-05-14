import { getConfig } from "../config.js";
import { PveClient } from "../lib/pve.js";

let pve: PveClient | null = null;

export function getPveClient(): PveClient {
  if (pve) return pve;
  const cfg = getConfig();
  pve = new PveClient({
    host: cfg.PVE_HOST,
    port: cfg.PVE_PORT,
    tokenId: cfg.PVE_TOKEN_ID,
    tokenSecret: cfg.PVE_TOKEN_SECRET,
    rejectUnauthorized: cfg.PVE_TLS_REJECT_UNAUTHORIZED,
  });
  return pve;
}
