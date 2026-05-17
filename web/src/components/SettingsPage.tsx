import { useState } from "react";
import { api } from "../api.js";
import { EnvEditor } from "./EnvEditor.js";
import { ServersEditor } from "./ServersEditor.js";
import { TailscalePanel } from "./TailscalePanel.js";
import { PveManager } from "./PveManager.js";

export function SettingsPage() {
  const [reloadStatus, setReloadStatus] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  async function reload() {
    setReloadStatus(null);
    setReloadError(null);
    setReloading(true);
    try {
      await api.reloadSettings();
      setReloadStatus("設定をリロードしました。");
    } catch (e) {
      setReloadError(String(e));
    } finally {
      setReloading(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2>設定の反映</h2>
          <button className="primary" disabled={reloading} onClick={reload}>
            {reloading ? "リロード中…" : "設定をリロード"}
          </button>
        </div>
        <p className="muted">
          .env / servers.local.yml を編集したあと、このボタンで再読み込みします（プロセス再起動不要）。
          BIND_HOST と PORT の変更だけはプロセス再起動が必要です。
        </p>
        {reloadStatus && <p className="muted">{reloadStatus}</p>}
        {reloadError && <p className="error">{reloadError}</p>}
      </section>

      <section className="card">
        <h2>環境変数 (.env)</h2>
        <EnvEditor onSaved={() => undefined} />
      </section>

      <section className="card">
        <h2>サーバ台帳 (servers.local.yml)</h2>
        <ServersEditor onSaved={() => undefined} />
      </section>

      <section className="card">
        <h2>Tailscale デバイス</h2>
        <p className="muted">
          Tailscale API 経由でデバイス一覧を取得します。サーバ台帳に IP を入力する際に参照してください。
        </p>
        <TailscalePanel />
      </section>

      <section className="card">
        <h2>PVE VM/CT 管理</h2>
        <p className="muted">PVE 上の VM/CT を作成・削除・CPU/メモリ変更します。</p>
        <PveManager />
      </section>
    </>
  );
}
