import { useState } from "react";
import { api, streamDeployLogs, type Deployment, type LogLine, type Repo } from "../api.js";
import { RepoPicker } from "./RepoPicker.js";
import { ServerPicker } from "./ServerPicker.js";
import { LogViewer } from "./LogViewer.js";

interface Props {
  onFinished: () => void;
}

export function DeployPanel({ onFinished }: Props) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [branch, setBranch] = useState("");
  const [serverName, setServerName] = useState("");
  const [takePreSnapshot, setTakePreSnapshot] = useState(false);

  const [deploying, setDeploying] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [result, setResult] = useState<Deployment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canDeploy = repo && branch && serverName && !deploying;

  async function deploy() {
    if (!repo) return;
    setError(null);
    setResult(null);
    setLines([]);
    setDeploying(true);
    try {
      const id = await api.startDeploy({
        repoFullName: repo.fullName,
        branch,
        serverName,
        takePreSnapshot,
      });
      streamDeployLogs(
        id,
        (line) => setLines((prev) => [...prev, line]),
        (deployment) => {
          setResult(deployment);
          setDeploying(false);
          onFinished();
        },
      );
    } catch (e) {
      setError(String(e));
      setDeploying(false);
    }
  }

  return (
    <section className="card">
      <h2>新規デプロイ</h2>
      <RepoPicker
        repo={repo}
        branch={branch}
        onRepoChange={setRepo}
        onBranchChange={setBranch}
      />
      <ServerPicker serverName={serverName} onChange={setServerName} />

      <label className="checkbox">
        <input
          type="checkbox"
          checked={takePreSnapshot}
          onChange={(e) => setTakePreSnapshot(e.target.checked)}
        />
        デプロイ前にスナップショットを作成する
      </label>

      <button className="primary" disabled={!canDeploy} onClick={deploy}>
        {deploying ? "デプロイ中…" : "デプロイ"}
      </button>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className={`result result-${result.status}`}>
          <strong>{statusLabel(result.status)}</strong>
          {result.tailscale_ip && (
            <p>
              Tailscale IP: <code>{result.tailscale_ip}</code>
            </p>
          )}
          {result.app_url && (
            <p>
              アプリ:{" "}
              <a href={result.app_url} target="_blank" rel="noreferrer">
                {result.app_url}
              </a>{" "}
              {result.health && (
                <span className={`badge badge-${result.health}`}>{healthLabel(result.health)}</span>
              )}
            </p>
          )}
          {result.error && <p className="error">{result.error}</p>}
        </div>
      )}

      <LogViewer lines={lines} />
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

function healthLabel(health: NonNullable<Deployment["health"]>): string {
  switch (health) {
    case "healthy": return "正常";
    case "unhealthy": return "異常";
    case "unknown": return "不明";
  }
}
