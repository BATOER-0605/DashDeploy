import { useEffect, useState } from "react";
import {
  api,
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

function CreateLxcForm({ node, onCreated }: { node: string; onCreated: () => void }) {
  const [storages, setStorages] = useState<PveStorage[]>([]);
  const [templates, setTemplates] = useState<PveStorageVolume[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateStorage, setTemplateStorage] = useState<string>("local");
  const [form, setForm] = useState<CreateLxcParams>({
    node,
    vmid: 200,
    ostemplate: "",
    hostname: "dashdeploy-target",
    cores: 1,
    memory: 1024,
    storage: "local-lvm",
    diskSize: 8,
    bridge: "vmbr0",
    ipConfig: "dhcp",
    unprivileged: true,
    start: false,
  });

  useEffect(() => {
    setForm((f) => ({ ...f, node }));
    api
      .listPveStorage(node)
      .then(setStorages)
      .catch((e) => setError(String(e)));
  }, [node]);

  useEffect(() => {
    if (!templateStorage) return;
    api
      .listPveStorageContent(node, templateStorage, "vztmpl")
      .then(setTemplates)
      .catch((e) => setError(String(e)));
  }, [node, templateStorage]);

  async function submit() {
    if (!form.ostemplate) {
      setError("OS テンプレートを選択してください。");
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

  const rootStorages = storages.filter((s) => s.content.includes("rootdir"));

  return (
    <details className="card-inner" open>
      <summary><strong>新規 LXC コンテナ作成</strong></summary>

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
          {storages
            .filter((s) => s.content.includes("vztmpl"))
            .map((s) => (
              <option key={s.storage} value={s.storage}>
                {s.storage}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label>OS テンプレート</label>
        <select
          value={form.ostemplate}
          onChange={(e) => setForm({ ...form, ostemplate: e.target.value })}
        >
          <option value="">— テンプレートを選択 —</option>
          {templates.map((t) => (
            <option key={t.volid} value={t.volid}>
              {t.volid}
            </option>
          ))}
        </select>
      </div>

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
        <label>ルートディスク ストレージ</label>
        <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
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
