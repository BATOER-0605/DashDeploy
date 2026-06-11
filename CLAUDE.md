# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **外部連携**: PVE REST API、GitHub REST API、SSH（`ssh2`）、Tailscale REST API。

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
| `./setup.sh` | 一般ユーザ権限で実行。依存インストール・ビルド後、`dashdeploy.service` を `/etc/systemd/system` に生成して `enable --now` する（sudo 内部使用、ユーザログイン不要で OS 起動時に自動起動） |

単一テストの実行: `npm -w server exec -- node --import tsx --test server/src/lib/pve.test.ts`

## ディレクトリ構成（要点のみ）

```
server/src/
  index.ts            Fastify 起動、プラグイン／ルート登録、静的配信
  config.ts           .env 読み込み + zod 検証（reloadConfig で再読込）
  inventory.ts        config/servers*.yml 読み込み + zod 検証（*.local.yml 優先）
  db/
    client.ts         better-sqlite3 + 起動時マイグレーション
    deployments.ts    deployments / deployment_events の CRUD + pruneInactiveDeployments
  lib/
    pve.ts            PveClient: PVE API（lxc/qemu 両対応、複数ホストフェイルオーバー、
                      UPID ポーリング、aplinfo カタログ／ダウンロード）
    github.ts         listRepos / listBranches / cloneUrl / verifyPat
    ssh.ts            runCommand / captureCommand（password・key 認証両対応）
    lines.ts          ストリームのバッファを行に分割（makeLineSplitter）
    logbus.ts         デプロイ毎のログ行ファンアウト（永続化 + SSE 配信）
    tailscale.ts      Tailscale REST API クライアント
  services/
    clients.ts        PveClient のシングルトン（resetPveClient で再生成）
    deploy.ts         デプロイ／復元のオーケストレーション（中核）
  routes/
    repos.ts servers.ts deploy.ts restore.ts history.ts health.ts
    settings.ts       .env / servers.local.yml の CRUD + リロード
    tailscale.ts      Tailscale API 経由のデバイス一覧
    pve.ts            ノード/ゲスト/ストレージ列挙、テンプレートゲスト列挙、
                      テンプレートクローン（LXC/VM 統一）、削除/設定変更、
                      aplinfo カタログ／ダウンロード
web/src/
  App.tsx api.ts      ホーム/設定ページのナビゲーション（state 切替）
  components/         DeployPanel / RepoPicker / ServerPicker / LogViewer / HistoryList
                      SettingsPage / EnvEditor / ServersEditor /
                      TailscalePanel / PveManager（CloneGuestPanel + DownloadTemplatePanel）
config/servers.yml    サニタイズ済みサンプル（実体は servers.local.yml を gitignore）
```

## アーキテクチャと処理フロー

### デプロイ（`services/deploy.ts: runDeployment`）

1. `POST /api/deploy` は `deployments` 行を `queued` で作成し、即座に `202 { deploymentId }` を返す。
   実処理は `runDeployment` を await せずにデタッチ実行する。
2. フロントは `EventSource('/api/deploy/:id/logs')` で SSE を開く。
3. `runDeployment` の各ステップは `logbus.publish()` でログ行を発行し、これが
   (a) `deployment_events` への永続化 (b) 接続中の SSE クライアントへの push を行う。
4. ステップ: ゲスト起動確認 → **SSH 到達待ち（`waitForSsh`）** → **Docker 自動セットアップ
   （未インストールなら `get.docker.com` で導入、冪等）** → 任意のプリスナップショット →
   SSH で clone → `.dashdeploy.yml` 読み取り → `docker compose up -d --build` →
   Tailscale IP 取得 → **公開ポート自動検出（`discoverAppPort`）** → ヘルスチェック。
5. 終了時に `deployments` を `success`／`failed` に更新し、`logbus.finish()` で SSE を閉じる。

### 復元（`services/deploy.ts: restoreDeployment`）

コールドスナップショット復元: ゲストが稼働中ならまず `pve.stop()` でパワーオフし、完了を
待ってから `pve.rollback()` を実行し、その後 `pve.start()` でパワーオンする。対象スナップ
ショットは引数指定がなければ `server.baselineSnapshot`（既定 `clean`）。

### SSE のリロード耐性（`routes/deploy.ts: streamLogs`）

接続時にまず `deployment_events` を再生し、その後 `logbus` の live イベントを購読する。
取りこぼし防止のため購読を先に行い、`LogLine.id` で再生済み行をスキップして重複を防ぐ。

### ポート自動検出（`services/deploy.ts: discoverAppPort`）

`docker compose up -d` のあと、`docker compose ps --format json`（フォールバックは
`docker ps`）でターゲット上の実公開ポートを検出する。インベントリ／`.dashdeploy.yml`
の `appPort` よりも検出値を優先する（compose 側の `ports:` マッピングと食い違って
404 になるのを防ぐため）。

### 設定リロード（`routes/settings.ts: POST /api/settings/reload`）

`reloadConfig()`（`config.ts`、`dotenv` を `override:true` で再読込）、
`resetPveClient()`（`services/clients.ts`）、`reloadInventory()`（`inventory.ts`）の
3 つを呼び、`.env` と `servers.local.yml` の変更をプロセス再起動なしで反映する。
`BIND_HOST` と `PORT` だけは Fastify の listen 後に変えられないため再起動が必要。

### 設定画面（`web/src/components/SettingsPage.tsx`）

ヘッダのナビゲーション（`App.tsx` の `page` state）で「ホーム」と「設定」を切り替える。
設定ページは 5 セクションを縦に並べる: 設定の反映ボタン / 環境変数（EnvEditor）/
サーバ台帳（ServersEditor、生 YAML）/ Tailscale デバイス（API 経由）/ PVE VM/CT 管理。

### カスタムテンプレートのクローン（`PveManager.tsx: CloneGuestPanel`）

PVE 上で `pct template` / `qm template` 済みのゲストを `GET /api/pve/nodes/:node/templates/guests`
（内部で `listGuests` の `template===1` 行をフィルタ）で一覧し、`POST /api/pve/clone`
（`PveClient.cloneGuest` → `/nodes/{node}/{kind}/{vmid}/clone`）で新規 vmid に複製する。
LXC は body に `hostname=`、QEMU は `name=` を入れる。`full=0` がリンククローン（既定）、
リンク非対応ストレージのときだけフルにする。クローン後 `start=true` なら起動して
`waitForGuestIp()`（LXC は `/lxc/{vmid}/interfaces`、QEMU は
`/qemu/{vmid}/agent/network-get-interfaces` を ~30s ポーリング）で DHCP IP を検出し、
`{ vmid, kind, detectedIp }` を返す。WebUI はこれを 2 ステップ UI にしてあり、ステップ 1
（クローン）完了後にステップ 2（inventory 登録）が現れ、SSH ホスト欄には `detectedIp` を
仮で流し込む（ユーザはゲスト内で `tailscale up` を打ってから Tailscale IP に書き換える想定）。
登録は `POST /api/settings/servers/entry` で `servers.local.yml` の `servers[]` に append し、
`reloadInventory()` を呼んで即時反映する。新規 vmid は `GET /api/pve/nextid`
（`/cluster/nextid`）で初期サジェスト。

生 vztmpl 系（`GET/POST /nodes/{node}/aplinfo`、`DownloadTemplatePanel`）はカスタム
テンプレートを作る前段の素材取得用に残してある（PVE シェルに入らず WebUI で完結させるため）。

### 履歴の一括削除（`db/deployments.ts: pruneInactiveDeployments`）

`POST /api/deployments/prune` は status が `failed` / `restored` / `queued` の行のみを
削除する（`success` と `running` は「稼働中扱い」として保持）。`deployment_events` は
外部キー `ON DELETE CASCADE` で連鎖削除されるため `foreign_keys = ON` 前提。

## 設計上の決定事項・注意点

- **PVE lxc/qemu 両対応**: API パスは `kind`（`lxc`／`qemu`）セグメント以外同形。
  `PveClient` のメソッドは `kind` を引数で受け取り、台帳の `kind` をそのまま渡す。
- **PVE クラスタ**: `PveClient` は複数ホストを受け取り、接続失敗時に次ホストへフェイルオーバー
  する。HTTP エラー応答は「ホストには到達できている」ため即 throw し、フェイルオーバーしない。
  クラスタはどのノード経由でも対象ノードへプロキシするため、ホストは 1 つでも足りる。
- **PVE 非同期処理**: start/stop/snapshot/rollback/aplinfo download は UPID を返す。
  `waitForTask` が `/nodes/{node}/tasks/{upid}/status` を `status==='stopped'` まで
  ポーリングし、`exitstatus!=='OK'` で `PveError` を投げる。
- **PVE 認証**: API トークン（`Authorization: PVEAPIToken=...`）。トークン認証なので
  CSRF トークン不要。自己署名証明書のため undici `Agent` で `rejectUnauthorized:false`。
- **PVE 権限**: デプロイと復元だけなら `VM.Audit / VM.PowerMgmt / VM.Snapshot /
  VM.Snapshot.Rollback` で足りる。VM/CT 管理機能（クローン・削除・CPU/メモリ変更）を使う場合は
  `VM.Allocate / VM.Clone / VM.Config.* / Datastore.Audit / Datastore.AllocateSpace /
  Datastore.AllocateTemplate / Sys.Audit` も必要（README.md 参照）。
- **テンプレートクローン方式**: 生 vztmpl から「ゼロから」LXC を作る経路は廃止した。事前に
  `pct template` / `qm template` 済みのテンプレートを用意し、それをクローンするフローに統一。
  PVE LXC は root SSH がデフォルト無効・生 vztmpl には root しかいない、という制約を回避する
  ため、テンプレート側に一般ユーザ + パスワードなし sudo + Tailscale を焼き込んでおき、
  inventory には焼き込んだユーザ名 + パスワードを登録する（パスワード SSH）。デプロイ側の
  Docker 自動セットアップは `$SUDO` プレフィクスで書かれているのでそのまま動く。
- **Docker の自動セットアップ**: ベースライン VM／CT に Tailscale だけが入っていることを前提と
  し、Docker は `ensureDockerScript()`（`services/deploy.ts`）が `get.docker.com` で初回のみ導入
  する。すべての docker コマンドは `$SUDO docker` で実行し、SSH ユーザーが root か非 root かを
  問わず動作する（非 root の場合はパスワードなし sudo を要求する）。
- **Tailscale API**: デバイスのオンライン判定は OpenAPI 仕様どおり `connectedToControl`
  を使う（`online` というフィールドは存在しない）。`TAILSCALE_TAILNET=-` は「API キー所有者の
  既定 tailnet」を指す特殊値で、迷ったらこれを使う。
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
- WebUI に新しい API を追加したら `web/src/api.ts` の `api` オブジェクトに wrapper を
  足し、型は同ファイル末尾の interface 群に置く。

## Git

- 開発ブランチ: `claude/pve-deployment-webapp-T0Daf`。
- リポジトリは空の状態から開始したため `main` ブランチが存在せず、現状 PR は作成できない。
  PR を作るにはベースとなる `main` ブランチが必要。
