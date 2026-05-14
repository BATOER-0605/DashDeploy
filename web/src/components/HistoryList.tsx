import { useState } from "react";
import { api, type Deployment } from "../api.js";

interface Props {
  deployments: Deployment[];
  onChanged: () => void;
}

export function HistoryList({ deployments, onChanged }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function redeploy(d: Deployment) {
    setError(null);
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
    if (!confirm(`Restore ${d.server_name} to its baseline snapshot?`)) return;
    setError(null);
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

  return (
    <section className="card">
      <h2>History</h2>
      {error && <p className="error">{error}</p>}
      {deployments.length === 0 && <p className="muted">No deployments yet.</p>}
      <table className="history">
        <thead>
          <tr>
            <th>#</th>
            <th>Repo</th>
            <th>Branch</th>
            <th>Server</th>
            <th>Status</th>
            <th>Tailscale IP</th>
            <th>Actions</th>
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
                <span className={`badge badge-${d.status}`}>{d.status}</span>
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
                <button disabled={busyId === d.id} onClick={() => redeploy(d)}>
                  Redeploy
                </button>
                <button
                  className="danger"
                  disabled={busyId === d.id}
                  onClick={() => restore(d)}
                >
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
