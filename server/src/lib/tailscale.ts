const API = "https://api.tailscale.com/api/v2";

export interface TailscaleDevice {
  id: string;
  name: string; // FQDN like host.tailXXXX.ts.net
  hostname: string;
  addresses: string[]; // IPv4 / IPv6
  os?: string;
  online?: boolean;
}

export class TailscaleError extends Error {}

interface RawDevice {
  id: string;
  name: string;
  hostname: string;
  addresses?: string[];
  os?: string;
  online?: boolean;
}

export async function listDevices(
  apiKey: string,
  tailnet: string,
): Promise<TailscaleDevice[]> {
  const url = `${API}/tailnet/${encodeURIComponent(tailnet)}/devices`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TailscaleError(
      `Tailscale API ${url} failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const body = (await res.json()) as { devices: RawDevice[] };
  return body.devices.map((d) => ({
    id: d.id,
    name: d.name,
    hostname: d.hostname,
    addresses: d.addresses ?? [],
    os: d.os,
    online: d.online,
  }));
}
