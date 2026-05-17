import { useEffect, useState } from "react";
import { api, type TailscaleDevice } from "../api.js";

export function TailscalePanel() {
  const [devices, setDevices] = useState<TailscaleDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    setError(null);
    api
      .listTailscaleDevices()
      .then(setDevices)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  function ipv4Of(d: TailscaleDevice): string | undefined {
    return d.addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  if (loading) return <p className="muted">読み込み中…</p>;
  if (error) {
    return (
      <div>
        <p className="error">{error}</p>
        <p className="muted">
          .env に <code>TAILSCALE_API_KEY</code> と <code>TAILSCALE_TAILNET</code> を設定し、
          リロードしてから再試行してください。
        </p>
      </div>
    );
  }
  if (!devices || devices.length === 0) return <p className="muted">デバイスが見つかりません。</p>;

  return (
    <div>
      <button onClick={refresh}>再取得</button>
      <table className="history" style={{ marginTop: "0.6rem" }}>
        <thead>
          <tr>
            <th>ホスト名</th>
            <th>OS</th>
            <th>状態</th>
            <th>IPv4</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const ip = ipv4Of(d);
            return (
              <tr key={d.id}>
                <td>{d.hostname || d.name}</td>
                <td>{d.os ?? "—"}</td>
                <td>
                  <span className={`badge badge-${d.online ? "success" : "failed"}`}>
                    {d.online ? "オンライン" : "オフライン"}
                  </span>
                </td>
                <td>
                  <code>{ip ?? "—"}</code>
                </td>
                <td>
                  {ip && (
                    <button onClick={() => copy(ip)} title="IP をコピー">
                      IP コピー
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
