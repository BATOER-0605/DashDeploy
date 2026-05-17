import { useEffect, useState } from "react";
import { api } from "../api.js";

interface Props {
  onSaved: () => void;
}

export function ServersEditor({ onSaved }: Props) {
  const [yaml, setYaml] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .getServersYaml()
      .then((r) => {
        setYaml(r.yaml);
        setPath(r.path);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      await api.saveServersYaml(yaml);
      setNotice(`保存しました (${path.endsWith(".local.yml") ? path : "config/servers.local.yml"})。リロードボタンで反映してください。`);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="muted">読み込み中…</p>;

  return (
    <div>
      <p className="muted">
        現在編集中: <code>{path}</code>。保存先は常に <code>config/servers.local.yml</code> です（gitignore 対象）。
      </p>
      <textarea
        className="yaml-editor"
        value={yaml}
        spellCheck={false}
        onChange={(e) => setYaml(e.target.value)}
      />
      <button className="primary" disabled={saving} onClick={save}>
        {saving ? "保存中…" : "保存"}
      </button>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
    </div>
  );
}
