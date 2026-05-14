# CLAUDE.md

このファイルは、このリポジトリで作業する際の Claude Code 向けガイドです。

## プロジェクト概要

DashDeploy は、GitHub リポジトリを自宅の Proxmox VE（PVE）の LXC／QEMU ターゲットへ
SSH + Docker でデプロイし、デプロイログを SSE で配信し、対象機の Tailscale IP を表示し、
PVE スナップショットで「クリーンな状態」に復元するための、単一ユーザー向け Web アプリです。

ユーザー体験のゴール: 「リポジトリ選択 → ブランチ選択 → デプロイ先選択 → デプロイ」を
最小手順で行い、テスト後はワンクリックで復元する。

## 技術スタック

- **バックエンド**: Node.js 20+ / TypeScript / Fastify 5。ESM（`"type": "module"`、NodeNext）。
- **フロントエンド**: React 18 + Vite 6 の SPA。
- **DB**: SQLite（`better-sqlite3`）。デプロイ履歴とログ行を永続化。
- **構成**: npm workspaces のモノレポ（`server` と `web`）。
- **外部連携**: PVE REST API、GitHub REST API、SSH（`ssh2`）。

## 開発コマンド

リポジトリルートで実行する（`npm start` は cwd をルートに前提とする — 設定ファイルや
`web/dist` をルートからの相対パスで解決するため）。

| コマンド | 用途 |
|---|---|
| `npm run setup` | 全 workspace の依存関係をインストール（冪等） |
| `npm run build` | `web` をビルドしてから `server` をビルド |
| `npm run dev` | server（tsx watch）+ web（Vite が `/api` をプロキシ）を並行起動 |
| `npm start` | `node server/dist/index.js`（本番。`web/dist` を静的配信） |
| `npm test` | server のユニットテスト（`node --test`） |
| `npm run migrate` | DB マイグレーション適用（起動時にも自動実行される） |

## ディレクトリ構成

```
server/src/
  index.ts            Fastify 起動、プラグイン／ルート登録、静的配信
  config.ts           .env 読み込み + zod 検証（getConfig）
  inventory.ts        config/servers*.yml 読み込み + zod 検証
  db/
    client.ts         better-sqlite3 インスタンス + 起動時マイグレーション
    migrations.ts     CREATE TABLE 定義
    deployments.ts    deployments / deployment_events の CRUD
  lib/
    pve.ts            PveClient: PVE API（lxc/qemu 両対応、複数ホストフェイルオーバー、UPID ポーリング）
    github.ts         listRepos / listBranches / cloneUrl / verifyPat
    ssh.ts            runCommand / captureCommand（password・key 認証両対応）
    lines.ts          ストリームのバッファを行に分割（makeLineSplitter）
    logbus.ts         デプロイ毎のログ行ファンアウト（永続化 + SSE 配信）
  services/
    clients.ts        PveClient のシングルトン生成
    deploy.ts         デプロイ／復元のオーケストレーション（中核）
  routes/
    repos.ts servers.ts deploy.ts restore.ts history.ts health.ts
web/src/
  App.tsx api.ts
  components/         RepoPicker / ServerPicker / DeployPanel / LogViewer / HistoryList
config/servers.yml    サニタイズ済みサンプル（実体は servers.local.yml を gitignore）
```

## アーキテクチャと処理フロー

### デプロイ（`services/deploy.ts: runDeployment`）

1. `POST /api/deploy` は `deployments` 行を `queued` で作成し、即座に `202 { deploymentId }` を返す。
   実処理は `runDeployment` を await せずにデタッチ実行する。
2. フロントは `EventSource('/api/deploy/:id/logs')` で SSE を開く。
3. `runDeployment` の各ステップは `logbus.publish()` でログ行を発行し、これが
   (a) `deployment_events` への永続化 (b) 接続中の SSE クライアントへの push を行う。
4. ステップ: ゲスト起動確認 → 任意のプリスナップショット → SSH で clone → `.dashdeploy.yml`
   読み取り → `docker compose up -d --build` → Tailscale IP 取得 → ヘルスチェック。
5. 終了時に `deployments` を `success`／`failed` に更新し、`logbus.finish()` で SSE を閉じる。

### 復元（`services/deploy.ts: restoreDeployment`）

コールドスナップショット復元: ゲストが稼働中ならまず `pve.stop()` でパワーオフし、完了を
待ってから `pve.rollback()` を実行する。対象スナップショットは引数指定がなければ
`server.baselineSnapshot`（既定 `clean`）。

### SSE のリロード耐性（`routes/deploy.ts: streamLogs`）

接続時にまず `deployment_events` を再生し、その後 `logbus` の live イベントを購読する。
取りこぼし防止のため購読を先に行い、`LogLine.id` で再生済み行をスキップして重複を防ぐ。

## 設計上の決定事項・注意点

- **PVE lxc/qemu 両対応**: API パスは `kind`（`lxc`／`qemu`）セグメント以外同形。
  `PveClient` のメソッドは `kind` を引数で受け取り、台帳の `kind` をそのまま渡す。
- **PVE クラスタ**: `PveClient` は複数ホストを受け取り、接続失敗時に次ホストへフェイルオーバー
  する。HTTP エラー応答は「ホストには到達できている」ため即 throw し、フェイルオーバーしない。
  クラスタはどのノード経由でも対象ノードへプロキシするため、ホストは 1 つでも足りる。
- **PVE 非同期処理**: start/stop/snapshot/rollback は UPID を返す。`waitForTask` が
  `/nodes/{node}/tasks/{upid}/status` を `status==='stopped'` までポーリングし、
  `exitstatus!=='OK'` で `PveError` を投げる。
- **PVE 認証**: API トークン（`Authorization: PVEAPIToken=...`）。トークン認証なので
  CSRF トークン不要。自己署名証明書のため undici `Agent` で `rejectUnauthorized:false`。
- **シークレットの取り扱い**: GitHub PAT と PVE トークンはブラウザに出さない。
  `/api/servers` は `listPublicServers()` でサニタイズ。PAT は `deploy.ts` の
  scrubber でログ行から除去してから永続化・配信する。clone は
  `https://x-access-token:<PAT>@github.com/...` を使い、clone 後に origin remote を
  削除して PAT をターゲットのディスクに残さない。
- **コードコメントは英語**、ユーザー向けドキュメント（README.md・CLAUDE.md）は日本語。
- **`data/` は gitignore**。`db/client.ts` が起動時にディレクトリ作成とマイグレーションを行う。
- **テスト**: `server/src/**/*.test.ts` を `node --test` で実行。外部接続はせず、
  `PveClient` は `fetchImpl` を注入してモックする。

## コードを変更したら

- `npm run build` と `npm test` が通ることを確認する。
- 実際の PVE／GitHub／SSH 接続を伴う結合テストは環境がないと実施できない。
  README.md の「手動の結合テスト チェックリスト」を参照。
- 設定スキーマ（`config.ts`／`inventory.ts`）を変えたら `.env.example` と
  `config/servers.yml` のサンプルも更新する。

## Git

- 開発ブランチ: `claude/pve-deployment-webapp-T0Daf`。
- リポジトリは空の状態から開始したため `main` ブランチが存在せず、現状 PR は作成できない。
  PR を作るにはベースとなる `main` ブランチが必要。
