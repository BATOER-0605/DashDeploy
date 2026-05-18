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
          原因と対処の目安:
        </p>
        <ul className="muted">
          <li>
            <code>TAILSCALE_API_KEY</code> が正しいか確認してください
            （<a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">
              tailscale.com で発行
            </a>）。
          </li>
          <li>
            <code>TAILSCALE_TAILNET</code> は組織用なら <code>example.com</code>、個人用なら
            ログインメール、もしくは特殊値 <code>-</code>（自分のデフォルト tailnet）を指定します。
          </li>
          <li>
            <code>fetch failed</code> と出る場合は DashDeploy ホストから
            <code>api.tailscale.com</code> へ到達できていません（DNS / IPv6 / Firewall を確認）。
          </li>
          <li>変更後は設定画面上部の「設定をリロード」を押してください。</li>
        </ul>
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
            <th>MagicDNS</th>
            <th>OS</th>
            <th>接続</th>
            <th>IPv4</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const ip = ipv4Of(d);
            const online = d.connectedToControl === true;
            return (
              <tr key={d.id}>
                <td>{d.hostname || d.name}</td>
                <td>
                  <code>{d.name}</code>
                </td>
                <td>{d.os ?? "—"}</td>
                <td>
                  <span className={`badge badge-${online ? "success" : "failed"}`}>
                    {online ? "オンライン" : "オフライン"}
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
