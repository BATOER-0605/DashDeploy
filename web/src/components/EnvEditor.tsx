import { useEffect, useState } from "react";
import { api } from "../api.js";

const LABELS: Record<string, string> = {
  GITHUB_PAT: "GitHub PAT",
  PVE_HOST: "PVE ホスト (カンマ区切りで複数可)",
  PVE_PORT: "PVE ポート",
  PVE_TOKEN_ID: "PVE トークン ID (例: root@pam!dashdeploy)",
  PVE_TOKEN_SECRET: "PVE トークンシークレット",
  PVE_TLS_REJECT_UNAUTHORIZED: "PVE TLS 証明書検証 (true/false)",
  BIND_HOST: "Bind ホスト",
  PORT: "Bind ポート",
  TAILSCALE_API_KEY: "Tailscale API キー",
  TAILSCALE_TAILNET: "Tailscale tailnet 名",
};

const SECRET_KEYS = new Set([
  "GITHUB_PAT",
  "PVE_TOKEN_SECRET",
  "TAILSCALE_API_KEY",
]);

interface Props {
  onSaved: () => void;
}

export function EnvEditor({ onSaved }: Props) {
  const [keys, setKeys] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEnv()
      .then((r) => {
        setKeys(r.keys);
        setValues(r.values);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      await api.saveEnv(values);
      setNotice(".env を保存しました。リロードボタンで変更を適用してください。");
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
      <label className="checkbox">
        <input
          type="checkbox"
          checked={showSecrets}
          onChange={(e) => setShowSecrets(e.target.checked)}
        />
        シークレットを表示
      </label>
      {keys.map((k) => (
        <div className="field" key={k}>
          <label>{LABELS[k] ?? k}</label>
          <input
            type={SECRET_KEYS.has(k) && !showSecrets ? "password" : "text"}
            value={values[k] ?? ""}
            onChange={(e) => setValues({ ...values, [k]: e.target.value })}
          />
        </div>
      ))}
      <button className="primary" disabled={saving} onClick={save}>
        {saving ? "保存中…" : "保存"}
      </button>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
    </div>
  );
}
