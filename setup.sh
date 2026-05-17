#!/usr/bin/env bash
# DashDeploy セットアップスクリプト
#   一般ユーザ権限で実行してください（必要な箇所だけ sudo を要求します）。
#   このスクリプトは以下を行います:
#     1. Node.js のバージョン確認
#     2. .env / config の存在確認
#     3. 依存関係のインストールとビルド
#     4. systemd ユニットを生成して /etc/systemd/system に配置
#     5. サービスを有効化＋起動（ユーザログイン不要で OS 起動時に自動実行）

set -euo pipefail

readonly REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SERVICE_NAME="dashdeploy.service"
readonly UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
readonly SERVICE_USER="$(id -un)"
readonly SERVICE_GROUP="$(id -gn)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. root では走らせない（systemd ユニットは個人ユーザで動かす想定）
if [ "$(id -u)" -eq 0 ]; then
  fail "root では実行しないでください。一般ユーザで実行してください（sudo は必要な箇所で内部的に呼び出します）。"
fi

# 2. Node.js >= 20
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js が見つかりません。Node.js 20 以上をインストールしてから再実行してください。"
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  fail "Node.js 20 以上が必要です（現在: $(node -v)）。"
fi
log "Node.js: $(node -v) (${NODE_BIN})"

# 3. sudo の確認（パスワード入力をここで一度だけ済ませる）
log "sudo の権限を確認します（必要ならパスワードを入力してください）..."
sudo -v

# 4. .env / config のチェック
if [ ! -f "${REPO_DIR}/.env" ]; then
  cp "${REPO_DIR}/.env.example" "${REPO_DIR}/.env"
  warn ".env が存在しなかったため .env.example からコピーしました。"
  warn "${REPO_DIR}/.env を編集して GITHUB_PAT / PVE_* を設定し、./setup.sh をもう一度実行してください。"
  exit 1
fi
if [ ! -f "${REPO_DIR}/config/servers.local.yml" ]; then
  warn "config/servers.local.yml が見つかりません。"
  warn "config/servers.yml をコピーして実際のターゲット情報を記入してください。"
fi

# 5. 依存関係インストール + ビルド
log "依存関係をインストールします..."
( cd "${REPO_DIR}" && npm run setup )
log "ビルドします..."
( cd "${REPO_DIR}" && npm run build )

# 6. systemd ユニットの生成
TMP_UNIT="$(mktemp)"
trap 'rm -f "${TMP_UNIT}"' EXIT
cat > "${TMP_UNIT}" <<UNIT
[Unit]
Description=DashDeploy - quick deploys to Proxmox VE targets
Documentation=https://github.com/BATOER-0605/DashDeploy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_BIN} ${REPO_DIR}/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# 7. ユニット配置 + 有効化（リブート時の自動起動）
log "systemd ユニットを ${UNIT_PATH} に配置します..."
sudo install -m 0644 "${TMP_UNIT}" "${UNIT_PATH}"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}" >/dev/null
sudo systemctl restart "${SERVICE_NAME}"

# 8. 起動確認
sleep 1
if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
  log "DashDeploy は systemd サービスとして稼働中です。"
else
  warn "サービスがアクティブになりませんでした。次のコマンドでログを確認してください:"
  warn "  journalctl -u ${SERVICE_NAME} -e --no-pager"
  sudo systemctl --no-pager status "${SERVICE_NAME}" || true
  exit 1
fi

echo
echo "  ステータス確認 : sudo systemctl status ${SERVICE_NAME}"
echo "  ライブログ     : journalctl -u ${SERVICE_NAME} -f"
echo "  再起動         : sudo systemctl restart ${SERVICE_NAME}"
echo "  停止           : sudo systemctl stop ${SERVICE_NAME}"
echo "  自動起動 無効  : sudo systemctl disable ${SERVICE_NAME}"
echo
echo "ブラウザから http://<BIND_HOST>:<PORT> にアクセスしてください（.env で設定）。"
