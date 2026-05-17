import { useCallback, useEffect, useState } from "react";
import { api, type Deployment } from "./api.js";
import { DeployPanel } from "./components/DeployPanel.js";
import { HistoryList } from "./components/HistoryList.js";

export function App() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  const refresh = useCallback(() => {
    api.listDeployments().then(setDeployments).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main>
      <header>
        <h1>DashDeploy</h1>
        <p className="muted">
          GitHub リポジトリを自宅 PVE のターゲットへデプロイし、テスト後はスナップショットで復元できます。
        </p>
      </header>
      <DeployPanel onFinished={refresh} />
      <HistoryList deployments={deployments} onChanged={refresh} />
    </main>
  );
}
