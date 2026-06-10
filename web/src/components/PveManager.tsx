import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AvailableTemplate,
  type CloneGuestParams,
  type PveGuest,
  type PveNode,
  type PveStorage,
  type ServerEntryInput,
  type TemplateGuest,
} from "../api.js";

export function PveManager() {
  const [nodes, setNodes] = useState<PveNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [guests, setGuests] = useState<PveGuest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPveNodes()
      .then((ns) => {
        setNodes(ns);
        if (ns[0]) setSelectedNode(ns[0].node);
      })
      .catch((e) => setError(String(e)));
  }, []);

  function refreshGuests(node = selectedNode) {
    if (!node) return;
    setError(null);
    api
      .listPveGuests(node)
      .then(setGuests)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    if (selectedNode) refreshGuests(selectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode]);

  async function remove(g: PveGuest) {
    if (!confirm(`${g.kind} ${g.vmid} (${g.name ?? "?"}) を削除しますか? (稼働中なら自動で停止します)`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteGuest(selectedNode, g.kind, g.vmid);
      setNotice(`${g.kind} ${g.vmid} を削除しました。`);
      refreshGuests();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function editResources(g: PveGuest) {
    const cores = prompt(`CPU コア数 (現在 ${g.cpus ?? "?"})`, String(g.cpus ?? 1));
    if (cores === null) return;
    const memMb = g.maxmem ? Math.round(g.maxmem / 1024 / 1024) : 512;
    const memory = prompt(`メモリ MB (現在 ${memMb})`, String(memMb));
    if (memory === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateGuestConfig(selectedNode, g.kind, g.vmid, {
        cores: Number(cores),
        memory: Number(memory),
      });
      setNotice(`${g.kind} ${g.vmid} の設定を更新しました。`);
      refreshGuests();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="field">
        <label>PVE ノード</label>
        <select value={selectedNode} onChange={(e) => setSelectedNode(e.target.value)}>
          {nodes.map((n) => (
            <option key={n.node} value={n.node}>
              {n.node} ({n.status})
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <h3>既存の VM/CT</h3>
      <table className="history">
        <thead>
          <tr>
            <th>種別</th>
            <th>VMID</th>
            <th>名前</th>
            <th>状態</th>
            <th>CPU</th>
            <th>メモリ</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {guests.map((g) => (
            <tr key={`${g.kind}-${g.vmid}`}>
              <td>{g.kind}</td>
              <td>{g.vmid}</td>
              <td>{g.name ?? "—"}</td>
              <td>
                <span className={`badge badge-${g.status === "running" ? "success" : "queued"}`}>
                  {g.status}
                </span>
              </td>
              <td>{g.cpus ?? "—"}</td>
              <td>{g.maxmem ? `${Math.round(g.maxmem / 1024 / 1024)} MB` : "—"}</td>
              <td className="actions">
                <button disabled={busy} onClick={() => editResources(g)}>
                  CPU/メモリ
                </button>
                <button className="danger" disabled={busy} onClick={() => remove(g)}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selectedNode && (
        <CloneGuestPanel
          node={selectedNode}
          onCloned={(msg) => {
            setNotice(msg);
            refreshGuests();
          }}
        />
      )}

      {selectedNode && (
        <details className="card-inner" style={{ marginTop: "1rem" }}>
          <summary>
            <strong>OS テンプレート（vztmpl）をダウンロード</strong>{" "}
            <span className="muted">— カスタム LXC テンプレートを作る前段で使います</span>
          </summary>
          <RawTemplateDownload node={selectedNode} />
        </details>
      )}
    </div>
  );
}

/**
 * PVE returns `content` as a comma-separated string (e.g. "vztmpl,iso,backup")
 * in current versions; older versions may return an array. Normalize.
 */
function contentsOf(s: PveStorage): string[] {
  const c = (s as unknown as { content?: string | string[] }).content;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return c.split(",").map((x) => x.trim());
  return [];
}

function CloneGuestPanel({
  node,
  onCloned,
}: {
  node: string;
  onCloned: (msg: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateGuest[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [storages, setStorages] = useState<PveStorage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sourceKey, setSourceKey] = useState<string>("");
  const [newVmid, setNewVmid] = useState<number | "">("");
  const [name, setName] = useState<string>("dashdeploy-target");
  const [full, setFull] = useState<boolean>(false);
  const [storage, setStorage] = useState<string>("");
  const [start, setStart] = useState<boolean>(true);

  const [registerInventory, setRegisterInventory] = useState<boolean>(true);
  const [invName, setInvName] = useState<string>("");
  const [invHost, setInvHost] = useState<string>("");
  const [invPort, setInvPort] = useState<number>(22);
  const [invUser, setInvUser] = useState<string>("");
  const [invPassword, setInvPassword] = useState<string>("");
  const [invAppPort, setInvAppPort] = useState<number | "">("");
  const [invBaseline, setInvBaseline] = useState<string>("clean");

  const reloadTemplates = useCallback(() => {
    setTemplatesLoaded(false);
    api
      .listTemplateGuests(node)
      .then((t) => {
        setTemplates(t);
        setTemplatesLoaded(true);
        if (t.length > 0 && !t.find((x) => `${x.kind}:${x.vmid}` === sourceKey)) {
          setSourceKey(`${t[0].kind}:${t[0].vmid}`);
        }
      })
      .catch((e) => {
        setError(String(e));
        setTemplatesLoaded(true);
      });
    // sourceKey intentionally omitted to avoid re-pinning during user edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  useEffect(() => {
    reloadTemplates();
    api
      .listPveStorage(node)
      .then(setStorages)
      .catch((e) => setError(String(e)));
    api
      .getNextVmid()
      .then((v) => setNewVmid(v))
      .catch(() => {
        /* non-fatal: user can type a vmid manually */
      });
  }, [node, reloadTemplates]);

  useEffect(() => {
    setInvName(name);
  }, [name]);

  const selectedTemplate = templates.find((t) => `${t.kind}:${t.vmid}` === sourceKey);
  const sourceKind = selectedTemplate?.kind;
  const cloneableStorages = storages.filter((s) =>
    contentsOf(s).includes(sourceKind === "qemu" ? "images" : "rootdir"),
  );

  async function submit() {
    setError(null);
    if (!selectedTemplate) {
      setError("クローン元テンプレートを選択してください。");
      return;
    }
    if (!newVmid || Number(newVmid) <= 0) {
      setError("新規 VMID を指定してください。");
      return;
    }
    if (!name.trim()) {
      setError("名前 / ホスト名を入力してください。");
      return;
    }
    if (registerInventory) {
      if (!invName.trim() || !invHost.trim() || !invUser.trim() || !invPassword) {
        setError("inventory 登録セクションのサーバ名・SSHホスト・ユーザ・パスワードを入力してください。");
        return;
      }
    }
    setBusy(true);
    try {
      const cloneParams: CloneGuestParams = {
        node,
        sourceKind: selectedTemplate.kind,
        sourceVmid: selectedTemplate.vmid,
        newVmid: Number(newVmid),
        name: name.trim(),
        full,
        start,
      };
      if (storage) cloneParams.storage = storage;
      const result = await api.cloneGuest(cloneParams);
      let msg = `${result.kind} ${result.vmid} (${name}) をクローンしました。`;
      if (registerInventory) {
        const entry: ServerEntryInput = {
          name: invName.trim(),
          pveNode: node,
          vmid: result.vmid,
          kind: result.kind,
          baselineSnapshot: invBaseline.trim() || "clean",
          ssh: {
            host: invHost.trim(),
            port: invPort || 22,
            user: invUser.trim(),
            auth: "password",
            password: invPassword,
          },
        };
        if (invAppPort && Number(invAppPort) > 0) entry.appPort = Number(invAppPort);
        await api.addServerEntry(entry);
        msg += ` inventory に "${entry.name}" を追加しました。`;
      }
      onCloned(msg);
      // Refresh template list (cloned guest may itself become a template later).
      reloadTemplates();
      // Bump suggested vmid for next clone.
      api
        .getNextVmid()
        .then((v) => setNewVmid(v))
        .catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card-inner" open>
      <summary><strong>テンプレートをクローンして新規 LXC/VM を作成</strong></summary>

      <p className="muted" style={{ marginTop: "0.4rem" }}>
        クローン元は PVE 上で <code>pct template</code> / <code>qm template</code> 済みの
        ゲストです。一般ユーザ + sudo + Tailscale（推奨: Docker）を入れたものをテンプレ化して
        おき、ここから複製してください。
      </p>

      <div className="field">
        <label>
          クローン元テンプレート{" "}
          <span className="muted">（{templates.length} 件）</span>
        </label>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <select
            value={sourceKey}
            onChange={(e) => setSourceKey(e.target.value)}
            disabled={!templatesLoaded || templates.length === 0}
            style={{ flex: 1 }}
          >
            <option value="">
              {!templatesLoaded
                ? "— 読み込み中 —"
                : templates.length === 0
                  ? "— テンプレートがありません（PVE で pct template / qm template 実行が必要） —"
                  : "— テンプレートを選択 —"}
            </option>
            {templates.map((t) => (
              <option key={`${t.kind}:${t.vmid}`} value={`${t.kind}:${t.vmid}`}>
                [{t.kind}] {t.vmid} {t.name ?? ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={reloadTemplates} title="一覧を再取得">
            ↻
          </button>
        </div>
      </div>

      <div className="field">
        <label>新規 VMID</label>
        <input
          type="number"
          value={newVmid}
          onChange={(e) => setNewVmid(e.target.value === "" ? "" : Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>名前 / ホスト名</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label>
          ターゲットストレージ{" "}
          <span className="muted">（未指定ならテンプレートのストレージを継承）</span>
        </label>
        <select value={storage} onChange={(e) => setStorage(e.target.value)}>
          <option value="">— 継承 —</option>
          {cloneableStorages.map((s) => (
            <option key={s.storage} value={s.storage}>
              {s.storage}
            </option>
          ))}
        </select>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={!full}
          onChange={(e) => setFull(!e.target.checked)}
        />
        リンククローン（既定。ストレージが非対応の場合のみ OFF にしてフルクローン）
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
        クローン完了後に起動
      </label>

      <details className="card-inner" open={registerInventory} style={{ marginTop: "0.8rem" }}>
        <summary>
          <label className="checkbox" style={{ display: "inline-flex" }}>
            <input
              type="checkbox"
              checked={registerInventory}
              onChange={(e) => setRegisterInventory(e.target.checked)}
            />
            <strong>inventory（servers.local.yml）に登録する</strong>
          </label>
        </summary>

        {registerInventory && (
          <>
            <p className="muted">
              テンプレートに焼き込んだ一般ユーザのパスワード認証情報を入力します。
              Tailscale IP は起動後に確認してから入力してください（後から
              <code> servers.local.yml </code>を編集して差し替えても OK）。
            </p>
            <div className="field">
              <label>サーバ名（inventory の name）</label>
              <input type="text" value={invName} onChange={(e) => setInvName(e.target.value)} />
            </div>
            <div className="field">
              <label>SSH ホスト（Tailscale IP 推奨）</label>
              <input type="text" value={invHost} onChange={(e) => setInvHost(e.target.value)} />
            </div>
            <div className="field">
              <label>SSH ポート</label>
              <input
                type="number"
                value={invPort}
                onChange={(e) => setInvPort(Number(e.target.value) || 22)}
              />
            </div>
            <div className="field">
              <label>SSH ユーザ（テンプレートに焼いた一般ユーザ）</label>
              <input type="text" value={invUser} onChange={(e) => setInvUser(e.target.value)} />
            </div>
            <div className="field">
              <label>SSH パスワード</label>
              <input
                type="password"
                value={invPassword}
                onChange={(e) => setInvPassword(e.target.value)}
              />
            </div>
            <div className="field">
              <label>アプリポート（任意）</label>
              <input
                type="number"
                value={invAppPort}
                onChange={(e) =>
                  setInvAppPort(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            </div>
            <div className="field">
              <label>ベースラインスナップショット名</label>
              <input
                type="text"
                value={invBaseline}
                onChange={(e) => setInvBaseline(e.target.value)}
              />
            </div>
          </>
        )}
      </details>

      <button className="primary" disabled={busy} onClick={submit}>
        {busy ? "クローン中…" : "クローン実行"}
      </button>
      {error && <p className="error">{error}</p>}
    </details>
  );
}

function RawTemplateDownload({ node }: { node: string }) {
  const [storages, setStorages] = useState<PveStorage[]>([]);
  const [storage, setStorage] = useState<string>("");
  useEffect(() => {
    api
      .listPveStorage(node)
      .then((s) => {
        setStorages(s);
        const vztmpl = s.filter((x) => contentsOf(x).includes("vztmpl"));
        if (vztmpl[0]) setStorage(vztmpl[0].storage);
      })
      .catch(() => {});
  }, [node]);
  const vztmplStorages = storages.filter((s) => contentsOf(s).includes("vztmpl"));
  return (
    <>
      <div className="field">
        <label>保存先ストレージ（vztmpl 対応）</label>
        <select value={storage} onChange={(e) => setStorage(e.target.value)}>
          <option value="">— ストレージを選択 —</option>
          {vztmplStorages.map((s) => (
            <option key={s.storage} value={s.storage}>
              {s.storage}
            </option>
          ))}
        </select>
      </div>
      {storage && <DownloadTemplatePanel node={node} storage={storage} onDownloaded={() => {}} />}
    </>
  );
}

function DownloadTemplatePanel({
  node,
  storage,
  onDownloaded,
}: {
  node: string;
  storage: string;
  onDownloaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AvailableTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    setError(null);
    setLoaded(false);
    api
      .listAvailableTemplates(node)
      .then((t) => {
        // Prefer the LXC `system` section but keep others available too.
        const sorted = [...t].sort((a, b) => {
          if (a.section === "system" && b.section !== "system") return -1;
          if (a.section !== "system" && b.section === "system") return 1;
          return a.template.localeCompare(b.template);
        });
        setCatalog(sorted);
        setLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
  }

  useEffect(() => {
    if (open && catalog.length === 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function download() {
    if (!selected) {
      setError("ダウンロードするテンプレートを選択してください。");
      return;
    }
    setError(null);
    setNotice(null);
    setDownloading(true);
    try {
      await api.downloadTemplate(node, storage, selected);
      setNotice(`${selected} を ${storage} にダウンロードしました。`);
      onDownloaded();
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  }

  const filtered = filter
    ? catalog.filter((c) =>
        `${c.template} ${c.os ?? ""} ${c.version ?? ""} ${c.description ?? ""}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
    : catalog;

  return (
    <details
      className="card-inner"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginBottom: "0.8rem" }}
    >
      <summary>
        <strong>テンプレートをダウンロード</strong>{" "}
        <span className="muted">（{storage} に保存）</span>
      </summary>

      {!loaded && <p className="muted">カタログを取得中…</p>}

      {loaded && (
        <>
          <div className="field">
            <label>カタログ絞り込み（例: ubuntu / debian）</label>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="ubuntu"
            />
          </div>
          <div className="field">
            <label>テンプレート（{filtered.length} 件）</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— テンプレートを選択 —</option>
              {filtered.map((c) => (
                <option key={c.template} value={c.template}>
                  [{c.section ?? "?"}] {c.template}
                  {c.version ? ` (${c.version})` : ""}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="primary" disabled={downloading} onClick={download}>
            {downloading ? "ダウンロード中…（数分かかる場合あり）" : "ダウンロード"}
          </button>
          <button type="button" onClick={load} style={{ marginLeft: "0.4rem" }}>
            カタログ再取得
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
    </details>
  );
}
