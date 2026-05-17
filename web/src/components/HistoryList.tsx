import { useState } from "react";
import { api, type Deployment } from "../api.js";

interface Props {
  deployments: Deployment[];
  onChanged: () => void;
}

const PRUNE_SENTINEL = -1;

export function HistoryList({ deployments, onChanged }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const prunable = deployments.filter((d) =>
    ["failed", "restored", "queued"].includes(d.status),
  ).length;

  async function redeploy(d: Deployment) {
    setError(null);
    setNotice(null);
    setBusyId(d.id);
    try {
      await api.startDeploy({
        repoFullName: d.repo_full_name,
        branch: d.branch,
        serverName: d.server_name,
        takePreSnapshot: false,
      });
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function restore(d: Deployment) {
    if (!confirm(`${d.server_name} をベースラインスナップショットに復元しますか?`)) return;
    setError(null);
    setNotice(null);
    setBusyId(d.id);
    try {
      await api.restore(d.id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function prune() {
    if (prunable === 0) return;
    if (!confirm(`稼働中ではない履歴 ${prunable} 件を一括削除しますか?（失敗・復元済み・待機中）`)) return;
    setError(null);
    setNotice(null);
    setBusyId(PRUNE_SENTINEL);
    try {
      const deleted = await api.pruneHistory();
      setNotice(`${deleted} 件の履歴を削除しました。`);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2>履歴</h2>
        <button
          className="danger"
          disabled={prunable === 0 || busyId !== null}
          onClick={prune}
          title="failed / restored / queued の履歴を一括削除します"
        >
          完了済みを一括削除{prunable > 0 ? `（${prunable}）` : ""}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
      {deployments.length === 0 && <p className="muted">デプロイ履歴はまだありません。</p>}
      {deployments.length > 0 && (
        <table className="history">
          <thead>
            <tr>
              <th>#</th>
              <th>リポジトリ</th>
              <th>ブランチ</th>
              <th>サーバ</th>
              <th>状態</th>
              <th>Tailscale IP</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td>
                <td>{d.repo_full_name}</td>
                <td>{d.branch}</td>
                <td>{d.server_name}</td>
                <td>
                  <span className={`badge badge-${d.status}`}>{statusLabel(d.status)}</span>
                </td>
                <td>
                  {d.app_url ? (
                    <a href={d.app_url} target="_blank" rel="noreferrer">
                      {d.tailscale_ip}
                    </a>
                  ) : (
                    d.tailscale_ip ?? "—"
                  )}
                </td>
                <td className="actions">
                  <button disabled={busyId !== null} onClick={() => redeploy(d)}>
                    再デプロイ
                  </button>
                  <button
                    className="danger"
                    disabled={busyId !== null}
                    onClick={() => restore(d)}
                  >
                    復元
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function statusLabel(status: Deployment["status"]): string {
  switch (status) {
    case "queued": return "待機中";
    case "running": return "実行中";
    case "success": return "成功";
    case "failed": return "失敗";
    case "restored": return "復元済み";
  }
}
