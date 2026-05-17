import { useCallback, useEffect, useState } from "react";
import { api, type Deployment } from "./api.js";
import { DeployPanel } from "./components/DeployPanel.js";
import { HistoryList } from "./components/HistoryList.js";
import { SettingsPage } from "./components/SettingsPage.js";

type Page = "home" | "settings";

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  const refresh = useCallback(() => {
    api.listDeployments().then(setDeployments).catch(() => {});
  }, []);

  useEffect(() => {
    if (page === "home") refresh();
  }, [page, refresh]);

  return (
    <main>
      <header>
        <div className="brand">
          <h1>DashDeploy</h1>
          <p className="muted">
            GitHub リポジトリを自宅 PVE のターゲットへデプロイし、テスト後はスナップショットで復元できます。
          </p>
        </div>
        <nav className="nav">
          <button
            className={page === "home" ? "nav-active" : ""}
            onClick={() => setPage("home")}
          >
            ホーム
          </button>
          <button
            className={page === "settings" ? "nav-active" : ""}
            onClick={() => setPage("settings")}
          >
            設定
          </button>
        </nav>
      </header>

      {page === "home" ? (
        <>
          <DeployPanel onFinished={refresh} />
          <HistoryList deployments={deployments} onChanged={refresh} />
        </>
      ) : (
        <SettingsPage />
      )}
    </main>
  );
}
