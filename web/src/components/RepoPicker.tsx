import { useEffect, useState } from "react";
import { api, type Repo } from "../api.js";

interface Props {
  repo: Repo | null;
  branch: string;
  onRepoChange: (repo: Repo | null) => void;
  onBranchChange: (branch: string) => void;
}

export function RepoPicker({ repo, branch, onRepoChange, onBranchChange }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    api.listRepos().then(setRepos).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!repo) {
      setBranches([]);
      return;
    }
    setLoadingBranches(true);
    api
      .listBranches(repo.fullName)
      .then((b) => {
        setBranches(b);
        if (!b.includes(branch)) onBranchChange(repo.defaultBranch);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingBranches(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  return (
    <div className="field">
      <label>Repository</label>
      <select
        value={repo?.fullName ?? ""}
        onChange={(e) => onRepoChange(repos.find((r) => r.fullName === e.target.value) ?? null)}
      >
        <option value="">— select a repository —</option>
        {repos.map((r) => (
          <option key={r.fullName} value={r.fullName}>
            {r.fullName} {r.private ? "(private)" : ""}
          </option>
        ))}
      </select>

      <label>Branch</label>
      <select
        value={branch}
        disabled={!repo || loadingBranches}
        onChange={(e) => onBranchChange(e.target.value)}
      >
        {loadingBranches && <option>loading…</option>}
        {!loadingBranches &&
          branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
      </select>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
