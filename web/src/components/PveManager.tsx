import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AvailableTemplate,
  type CreateLxcParams,
  type PveGuest,
  type PveNode,
  type PveStorage,
  type PveStorageVolume,
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
        <CreateLxcForm
          node={selectedNode}
          onCreated={() => {
            setNotice("LXC を作成しました。");
            refreshGuests();
          }}
        />
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

function CreateLxcForm({ node, onCreated }: { node: string; onCreated: () => void }) {
  const [storages, setStorages] = useState<PveStorage[]>([]);
  const [storagesLoaded, setStoragesLoaded] = useState(false);
  const [templates, setTemplates] = useState<PveStorageVolume[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateStorage, setTemplateStorage] = useState<string>("");
  const [form, setForm] = useState<CreateLxcParams>({
    node,
    vmid: 200,
    ostemplate: "",
    hostname: "dashdeploy-target",
    cores: 1,
    memory: 1024,
    storage: "",
    diskSize: 8,
    bridge: "vmbr0",
    ipConfig: "dhcp",
    unprivileged: true,
    start: false,
  });

  const vztmplStorages = storages.filter((s) => contentsOf(s).includes("vztmpl"));
  const rootStorages = storages.filter((s) => contentsOf(s).includes("rootdir"));

  useEffect(() => {
    setForm((f) => ({ ...f, node }));
    setStoragesLoaded(false);
    api
      .listPveStorage(node)
      .then((s) => {
        setStorages(s);
        setStoragesLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setStoragesLoaded(true);
      });
  }, [node]);

  // Once storages load, auto-pick the first storage that supports vztmpl
  // (templates) and rootdir (LXC rootfs) so the dropdowns aren't empty
  // pointing at "local"/"local-lvm" names that don't exist on this PVE.
  useEffect(() => {
    if (!storagesLoaded) return;
    if (vztmplStorages.length > 0 && !vztmplStorages.find((s) => s.storage === templateStorage)) {
      setTemplateStorage(vztmplStorages[0].storage);
    }
    if (rootStorages.length > 0 && !rootStorages.find((s) => s.storage === form.storage)) {
      setForm((f) => ({ ...f, storage: rootStorages[0].storage }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storagesLoaded, storages]);

  const reloadTemplates = useCallback(() => {
    if (!templateStorage) {
      setTemplates([]);
      setTemplatesLoaded(false);
      return;
    }
    setTemplatesLoaded(false);
    api
      .listPveStorageContent(node, templateStorage, "vztmpl")
      .then((t) => {
        // Defensive client-side filter: only keep entries that actually look
        // like LXC templates (`<storage>:vztmpl/<file>`) — PVE versions vary
        // in how strictly the `?content=vztmpl` query param filters.
        const filtered = t.filter(
          (v) => v.content === "vztmpl" || /\/vztmpl\//.test(v.volid),
        );
        setTemplates(filtered);
        setTemplatesLoaded(true);
        setForm((f) =>
          filtered.find((v) => v.volid === f.ostemplate) ? f : { ...f, ostemplate: "" },
        );
      })
      .catch((e) => {
        setError(String(e));
        setTemplatesLoaded(true);
      });
  }, [node, templateStorage]);

  useEffect(() => {
    reloadTemplates();
  }, [reloadTemplates]);

  async function submit() {
    if (!form.ostemplate) {
      setError("OS テンプレートを選択してください。");
      return;
    }
    if (!form.storage) {
      setError("ルートディスクのストレージを選択してください。");
      return;
    }
    setError(null);
    setCreating(true);
    try {
      await api.createLxc(form);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <details className="card-inner" open>
      <summary><strong>新規 LXC コンテナ作成</strong></summary>

      {storagesLoaded && vztmplStorages.length === 0 && (
        <p className="error">
          このノードに vztmpl 対応ストレージが見つかりません。PVE のデータセンター設定で
          ストレージの「コンテンツ」に <code>vztmpl</code> を追加してください。
        </p>
      )}

      <div className="field">
        <label>VMID</label>
        <input
          type="number"
          value={form.vmid}
          onChange={(e) => setForm({ ...form, vmid: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>ホスト名</label>
        <input
          type="text"
          value={form.hostname ?? ""}
          onChange={(e) => setForm({ ...form, hostname: e.target.value })}
        />
      </div>

      <div className="field">
        <label>テンプレート格納ストレージ</label>
        <select value={templateStorage} onChange={(e) => setTemplateStorage(e.target.value)}>
          <option value="">— ストレージを選択 —</option>
          {vztmplStorages.map((s) => (
            <option key={s.storage} value={s.storage}>
              {s.storage}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          OS テンプレート{" "}
          <span className="muted">
            （{templates.length} 件
            {templatesLoaded && templateStorage && templates.length === 0
              ? "／下のダウンロード欄から取得できます"
              : ""}
            ）
          </span>
        </label>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <select
            value={form.ostemplate}
            onChange={(e) => setForm({ ...form, ostemplate: e.target.value })}
            disabled={!templateStorage || templates.length === 0}
            style={{ flex: 1 }}
          >
            <option value="">
              {!templateStorage
                ? "— まずストレージを選択 —"
                : !templatesLoaded
                  ? "— 読み込み中 —"
                  : templates.length === 0
                    ? "— テンプレートが見つかりません —"
                    : "— テンプレートを選択 —"}
            </option>
            {templates.map((t) => (
              <option key={t.volid} value={t.volid}>
                {t.volid}
              </option>
            ))}
          </select>
          <button type="button" onClick={reloadTemplates} title="一覧を再取得">
            ↻
          </button>
        </div>
      </div>

      {templateStorage && (
        <DownloadTemplatePanel
          node={node}
          storage={templateStorage}
          onDownloaded={reloadTemplates}
        />
      )}

      <div className="field">
        <label>CPU コア</label>
        <input
          type="number"
          value={form.cores}
          onChange={(e) => setForm({ ...form, cores: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>メモリ (MB)</label>
        <input
          type="number"
          value={form.memory}
          onChange={(e) => setForm({ ...form, memory: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>
          ルートディスク ストレージ
          {storagesLoaded && rootStorages.length === 0 && (
            <span className="muted">
              （rootdir 対応ストレージがありません。PVE のストレージ設定で
              「コンテンツ」に <code>rootdir</code> を追加してください）
            </span>
          )}
        </label>
        <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
          <option value="">— ストレージを選択 —</option>
          {rootStorages.map((s) => (
            <option key={s.storage} value={s.storage}>
              {s.storage}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>ディスクサイズ (GB)</label>
        <input
          type="number"
          value={form.diskSize}
          onChange={(e) => setForm({ ...form, diskSize: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>ネットワークブリッジ</label>
        <input
          type="text"
          value={form.bridge}
          onChange={(e) => setForm({ ...form, bridge: e.target.value })}
        />
      </div>
      <div className="field">
        <label>IP 設定（"dhcp" または "ip=1.2.3.4/24,gw=1.2.3.1"）</label>
        <input
          type="text"
          value={form.ipConfig}
          onChange={(e) => setForm({ ...form, ipConfig: e.target.value })}
        />
      </div>

      <div className="field">
        <label>root パスワード (任意・5文字以上)</label>
        <input
          type="password"
          value={form.password ?? ""}
          onChange={(e) => setForm({ ...form, password: e.target.value || undefined })}
        />
      </div>
      <div className="field">
        <label>SSH 公開鍵 (任意)</label>
        <textarea
          value={form.sshPublicKey ?? ""}
          rows={2}
          onChange={(e) => setForm({ ...form, sshPublicKey: e.target.value || undefined })}
        />
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.unprivileged}
          onChange={(e) => setForm({ ...form, unprivileged: e.target.checked })}
        />
        unprivileged コンテナにする
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.start}
          onChange={(e) => setForm({ ...form, start: e.target.checked })}
        />
        作成後に起動
      </label>

      <button className="primary" disabled={creating} onClick={submit}>
        {creating ? "作成中…" : "作成"}
      </button>
      {error && <p className="error">{error}</p>}
    </details>
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
