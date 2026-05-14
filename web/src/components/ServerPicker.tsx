import { useEffect, useState } from "react";
import { api, type Server } from "../api.js";

interface Props {
  serverName: string;
  onChange: (serverName: string) => void;
}

export function ServerPicker({ serverName, onChange }: Props) {
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listServers().then(setServers).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="field">
      <label>Target server</label>
      <select value={serverName} onChange={(e) => onChange(e.target.value)}>
        <option value="">— select a target —</option>
        {servers.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} ({s.kind})
          </option>
        ))}
      </select>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
