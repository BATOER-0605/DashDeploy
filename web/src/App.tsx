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
          Deploy a GitHub repo to a Proxmox VE target, then restore it to a clean snapshot.
        </p>
      </header>
      <DeployPanel onFinished={refresh} />
      <HistoryList deployments={deployments} onChanged={refresh} />
    </main>
  );
}
