const API = "https://api.tailscale.com/api/v2";

export interface TailscaleDevice {
  id: string;
  name: string; // MagicDNS FQDN
  hostname: string; // short machine name
  addresses: string[];
  os?: string;
  connectedToControl?: boolean;
  lastSeen?: string;
}

export class TailscaleError extends Error {}

interface RawDevice {
  id: string;
  name: string;
  hostname: string;
  addresses?: string[];
  os?: string;
  connectedToControl?: boolean;
  lastSeen?: string;
}

export async function listDevices(
  apiKey: string,
  tailnet: string,
): Promise<TailscaleDevice[]> {
  const url = `${API}/tailnet/${encodeURIComponent(tailnet)}/devices`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    // Node's fetch wraps the real network/DNS/TLS error in `err.cause`;
    // surface it so the UI shows something actionable instead of just "fetch failed".
    const e = err as Error & { cause?: unknown };
    const cause =
      e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : "";
    throw new TailscaleError(
      `Tailscale API ${url} へ到達できません: ${e.message}${cause ? ` (${cause})` : ""}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TailscaleError(
      `Tailscale API ${url} がエラーを返しました: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const body = (await res.json()) as { devices: RawDevice[] };
  return body.devices.map((d) => ({
    id: d.id,
    name: d.name,
    hostname: d.hostname,
    addresses: d.addresses ?? [],
    os: d.os,
    connectedToControl: d.connectedToControl,
    lastSeen: d.lastSeen,
  }));
}
