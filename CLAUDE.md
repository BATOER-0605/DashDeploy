# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 現在の作業状態（最重要・新規セッション必読）

- **作業ブランチ**: `claude/pve-deployment-webapp-T0Daf`（必ずこのブランチで作業）
- **ベース**: `main`
- **オープン PR**: [#2 PVE: switch LXC/VM creation to custom-template clone](https://github.com/BATOER-0605/DashDeploy/pull/2)（draft）
- **最新コミット**:
  - `088e2c0` Clone: auto-detect DHCP IP and split inventory registration into step 2
  - `7ca7be7` PVE: switch LXC/VM creation to custom template clone
- **直近の設計判断**: LXC／VM 作成は「生 vztmpl からゼロから作る」フローを撤去し、**事前に `pct template` / `qm template` 済みのカスタムテンプレートを `pct clone` / `qm clone` する**方式に統一済み。PVE LXC は root SSH がデフォルト無効・生 vztmpl には root しかいないという制約を、テンプレ側に一般ユーザ + パスワードなし sudo + Tailscale（+ Docker 推奨）を焼き込むことで回避する。詳細は §「カスタムテンプレートのクローン」参照。
- **コード状況**: `npm run build` クリーン、`npm test` 19/19 pass（PVE クライアントのモック単体テスト）。
- **未済の検証**（実機が必要・自動化不可）:
  1. カスタム LXC テンプレートを 1 つ用意して WebUI からクローン → inventory 自動登録 → ホームでサーバ選択肢に出る → デプロイ成功 → 復元成功
  2. 同じ流れを VM テンプレートでも実施（qemu-guest-agent が入っていれば `detectedIp` が返る、なければ手動入力）
  3. クローン直後に `pct snapshot <vmid> clean` / `qm snapshot <vmid> clean` を手動で撮らないと「復元」ボタンが効かない（自動取得は将来課題）
- **撤去済みのもの**: 旧 `POST /api/pve/lxc`（生 vztmpl から CT 作成）、`PveClient.createLxc`、旧 `CreateLxcForm` UI、旧 `services/provision.ts` / `ProvisionForm.tsx`（cloud-init ベース）。再導入してはいけない。
- **残置されているもの**: `DownloadTemplatePanel`（`GET/POST /api/pve/templates/download` 含む）。これは「カスタムテンプレートを作る前段で生 vztmpl を取得する」素材取得用として意図的に残してある。

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

**全体像**: 「テンプレート選択 → クローン実行 → IP 自動検出 → inventory 登録」の 2 ステップ UI。

**サーバ側のメソッド**（`server/src/lib/pve.ts`）:
- `listTemplateGuests(node)` — `listGuests(node)` の結果から `template === 1` を抽出。LXC/QEMU 混在で返す。
- `getNextVmid()` — `GET /cluster/nextid` を呼び number で返す（フォーム初期値）。
- `cloneGuest(node, kind, sourceVmid, { newid, name, full, storage?, target?, description? })` — `POST /nodes/{node}/{kind}/{vmid}/clone`。LXC は `hostname=`、QEMU は `name=` に変換して送る。`full=false` がリンククローン（既定）。UPID を返す。
- `detectGuestIp(node, kind, vmid)` — LXC: `GET /nodes/{node}/lxc/{vmid}/interfaces` の `inet` から最初の global IPv4。QEMU: `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`（qemu-guest-agent 必須）。失敗時は `null`。
- `waitForGuestIp(node, kind, vmid, { timeoutMs=30000, intervalMs=3000 })` — `detectGuestIp` を非 null になるまでポーリング、タイムアウトで `null`。
- ループバック・リンクローカルを除外する `isGlobalIpv4` ヘルパが同ファイル末尾に。

**HTTP エンドポイント**（`server/src/routes/pve.ts`）:
- `GET  /api/pve/nodes/:node/templates/guests` → `{ templates: TemplateGuest[] }`
- `GET  /api/pve/nextid` → `{ vmid: number }`
- `POST /api/pve/clone` body: `{ node, sourceKind: "lxc"|"qemu", sourceVmid, newVmid, name, full?, storage?, description?, start? }` → `{ ok: true, vmid, kind, detectedIp: string | null }`。`start=true` のときだけ起動 + IP 検出を行う。
- `POST /api/settings/servers/entry`（`server/src/routes/settings.ts`）body: `ServerEntry`（zod 検証）。`servers.local.yml` が無ければ `servers.yml` を雛形に新規作成、`servers[]` に append、`name` 重複は 409、成功時 `reloadInventory()` を呼んで即時反映。

**WebUI**（`web/src/components/PveManager.tsx: CloneGuestPanel`）:
- ステート: `cloneResult: { vmid, kind, detectedIp } | null`。`null` の間は登録ブロックを出さない。
- ステップ 1（`runClone`）: テンプレート選択（lxc/qemu 混在ドロップダウン）・新規 vmid・名前 / ホスト名・リンククローン切替・起動切替 → `api.cloneGuest()`。成功で `cloneResult` をセット、`invHost` を `detectedIp ?? ""` で前埋め、`invName` を空ならホスト名で初期化。
- ステップ 2（`registerInInventory`）: SSH ユーザ・パスワード・ポート・アプリポート・ベースラインスナップショット名を編集してから `api.addServerEntry()`。`invHost` は **DHCP IP が仮で入っている** ことをガイド文で明示し、Tailscale IP に書き換える前提。
- IP 検出失敗時はエラーメッセージで手動入力を促す。

**スコープ外（将来課題）**:
- クローン後の `clean` スナップショット自動取得（今は手動で `pct snapshot <vmid> clean` を打つ前提。README にも明記）。
- Tailscale auth key の自動投入（テンプレ側に焼くか、ユーザがゲスト内で `tailscale up` する想定）。

**残置 UI**: `DownloadTemplatePanel`（`GET /api/pve/nodes/:node/templates/available`、`POST /api/pve/templates/download`）は「カスタムテンプレートを作る前段で生 vztmpl を取得する」素材取得用として残してある。`PveManager` の下半分に `RawTemplateDownload` 経由で配置。

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

## HTTP エンドポイント一覧（参考）

| メソッド | パス | 用途 |
|---|---|---|
| GET  | `/api/repos` | GitHub リポジトリ一覧（PAT 必要） |
| GET  | `/api/repos/:owner/:repo/branches` | ブランチ一覧 |
| GET  | `/api/servers` | inventory のサニタイズ済み一覧（シークレット除外） |
| GET  | `/api/deployments` | デプロイ履歴 |
| POST | `/api/deploy` | デプロイ開始（即時 202 + 後続 SSE） |
| GET  | `/api/deploy/:id/logs` | SSE ログストリーム（永続化分の再生 + live） |
| POST | `/api/deployments/:id/restore` | スナップショット復元 |
| POST | `/api/deployments/prune` | 履歴一括削除（failed/restored/queued のみ） |
| GET  | `/api/settings/env` / POST 同 | `.env` の読み書き（許可キーのみ） |
| GET  | `/api/settings/servers` / POST 同 | `servers.local.yml` の生 YAML 読み書き |
| POST | `/api/settings/servers/entry` | **構造化された ServerEntry を append**（クローン UI 用） |
| POST | `/api/settings/reload` | config + PVE client + inventory を再読込 |
| GET  | `/api/tailscale/devices` | Tailscale デバイス一覧 |
| GET  | `/api/pve/nodes` | PVE ノード一覧 |
| GET  | `/api/pve/nodes/:node/guests` | 全ゲスト一覧（lxc + qemu） |
| GET  | `/api/pve/nodes/:node/storage` | ストレージ一覧 |
| GET  | `/api/pve/nodes/:node/storage/:storage/content` | ストレージ内容（テンプレ等） |
| GET  | `/api/pve/nodes/:node/templates/available` | aplinfo カタログ |
| POST | `/api/pve/templates/download` | aplinfo ダウンロード |
| GET  | `/api/pve/nodes/:node/templates/guests` | **テンプレ化済みゲスト一覧（クローン元）** |
| GET  | `/api/pve/nextid` | **次の空き vmid** |
| POST | `/api/pve/clone` | **テンプレートクローン + 起動 + IP 検出** |
| DELETE | `/api/pve/guests/:node/:kind/:vmid` | ゲスト削除 |
| PUT  | `/api/pve/guests/:node/:kind/:vmid/config` | CPU/メモリ更新 |
| GET  | `/api/health` | ヘルス（GitHub PAT・inventory 読込可否） |

太字は今回のクローン再設計で新規／変更されたもの。

## コードを変更したら

- `npm run build` と `npm test` が通ることを確認する（現在 19/19）。
- 実際の PVE／GitHub／SSH 接続を伴う結合テストは環境がないと実施できない。
  README.md の「手動の結合テスト チェックリスト」と、本ファイル冒頭の「未済の検証」を参照。
- 設定スキーマ（`config.ts`／`inventory.ts`）を変えたら `.env.example` と
  `config/servers.yml` のサンプルも更新する。
- WebUI に新しい API を追加したら `web/src/api.ts` の `api` オブジェクトに wrapper を
  足し、型は同ファイル末尾の interface 群に置く。
- PVE クライアントに新メソッドを追加したら `server/src/lib/pve.test.ts` に
  `fetchImpl` モックパターンで単体テストを追加する。

## Git

- **開発ブランチ**: `claude/pve-deployment-webapp-T0Daf`（push 先もここ。`main` には直接 push しない）。
- **ベース**: `main`（既に存在）。
- **オープン PR**: [#2 PVE: switch LXC/VM creation to custom-template clone](https://github.com/BATOER-0605/DashDeploy/pull/2)（draft）。同じ作業を続ける場合は、新規 PR ではなくこの PR に追加コミットを push する。
- **新規セッション開始時の手順**:
  1. `git fetch origin claude/pve-deployment-webapp-T0Daf`
  2. `git checkout claude/pve-deployment-webapp-T0Daf`（ローカルブランチが古い場合は `git pull --ff-only`）
  3. `npm run setup && npm run build && npm test` で 19/19 pass を確認
- **過去にロールバックした方針**（再導入しないこと）: cloud-init / `ProvisionForm.tsx` / `services/provision.ts` 経由のゼロからプロビジョニング。LXC は root SSH が既定で無効・生 vztmpl には root しかいないため、この方向は実機で機能しなかった。代替が現在の「カスタムテンプレートクローン」方式。

## サーバ台帳スキーマ（`server/src/inventory.ts`）参考

クローン UI から `POST /api/settings/servers/entry` で追加されるエントリの形:

```yaml
servers:
  - name: dashdeploy-target            # inventory のユニーク名
    pveNode: pve                       # PVE ノード名
    vmid: 101                          # クローン後の新しい vmid
    kind: lxc                          # lxc | qemu
    baselineSnapshot: clean            # 復元時の対象スナップショット
    appPort: 3000                      # 任意（自動検出が優先される）
    healthPath: /                      # 任意
    ssh:
      host: 100.x.x.x                  # Tailscale IP に手動置換推奨
      port: 22
      user: dashdeploy                 # テンプレに焼いた一般ユーザ
      auth: password
      password: "..."                  # 同上
```

`servers.local.yml` が無ければ `config/servers.yml` を雛形にコピーして書き出す（gitignore 対象）。
key 認証も使えるが、現在の WebUI フォームは password 専用。key 認証で登録したい場合は生 YAML を直接編集（設定画面の `ServersEditor`）。
