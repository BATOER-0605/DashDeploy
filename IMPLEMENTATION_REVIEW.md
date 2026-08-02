# DashDeploy 実装調査・PVE 連携検証ガイド

調査日: 2026-08-02

対象コミット: `99f0aaa` (`claude/pve-deployment-webapp-T0Daf`)

調査方法: ソースコード、設定例、既存ドキュメント、ユニットテスト、TypeScript ビルドの確認

## 1. 結論

DashDeploy は、GitHub リポジトリを Proxmox VE（以下 PVE）の LXC／QEMU VM へ SSH 経由でデプロイし、テスト後に PVE スナップショットへ戻す、単一ユーザー向け Web アプリとして実装されている。

PVE クライアント自体には、API トークン認証、複数 PVE ホストのフェイルオーバー、ゲストの起動・停止、スナップショット作成・ロールバック、テンプレートのクローン、CPU／メモリ変更、IP アドレス検出が実装されている。モックを用いたユニットテスト 19 件と Web／サーバーのビルドは成功した。

ただし、現在のテストは PVE 実機へ接続しないため、実環境のホスト到達性、TLS、トークン形式、ACL、ストレージ、テンプレート、クラスタ構成は未検証である。特に、次の点は実環境で「PVE 連携が動かない」原因になりやすい。

1. API トークンまたはトークン所有ユーザーの権限不足
2. PVE の自己署名証明書／名前解決／TCP 8006 への到達性
3. `pveNode` に指定した値と実際の PVE ノード名の不一致
4. 既定のリンククローンを保存先ストレージがサポートしていない
5. QEMU の IP 自動検出に必要な `qemu-guest-agent` が未導入または停止中

また、PVE 連携以前に対処すべきセキュリティ上の不一致がある。`GET /api/settings/env` は `.env` の PVE トークン、GitHub PAT、Tailscale API キーをブラウザへ返す実装であり、README の「GitHub PAT と PVE トークンはブラウザに送られない」という説明と一致しない。アプリ自体にも認証機構がないため、修正するまではインターネットへ公開してはならず、検証時も `127.0.0.1` または厳格な Tailscale ACL／リバースプロキシの内側に限定すべきである。

## 2. システム構成

| レイヤー | 実装 | 主な役割 |
|---|---|---|
| Web | React 18 + Vite + TypeScript | デプロイ操作、履歴、設定、Tailscale、PVE VM/CT 管理 |
| API | Fastify 5 + TypeScript | GitHub／PVE／Tailscale／SSH の統合、SSE ログ配信 |
| DB | SQLite (`better-sqlite3`) | デプロイ履歴とログイベントの永続化 |
| PVE | REST API + API token | VM/CT、スナップショット、テンプレート、タスク操作 |
| ターゲット操作 | `ssh2` | Git clone、Docker 導入、ビルド、起動、Tailscale IP 取得 |
| 構成管理 | `.env` + `config/servers.local.yml` | 外部 API 認証情報とデプロイ先台帳 |

主要ディレクトリは次のとおり。

```text
server/src/
  index.ts                 Fastify 起動とルート登録
  config.ts                .env 読み込み・検証・再読み込み
  inventory.ts             servers*.yml 読み込み・検証
  lib/pve.ts               PVE REST API クライアント
  lib/github.ts            GitHub API と clone URL
  lib/ssh.ts               SSH コマンド実行
  services/deploy.ts       デプロイ／復元のオーケストレーション
  routes/pve.ts            PVE 管理 API
  routes/settings.ts       .env／台帳の読み書き API
web/src/
  api.ts                   API クライアント
  components/PveManager.tsx PVE 管理 UI
  components/DeployPanel.tsx デプロイ UI
config/servers.yml         サニタイズ済み台帳例
```

## 3. 実装済み機能

### 3.1 デプロイ

`POST /api/deploy` はデプロイ履歴を `queued` で作成して `202` を返し、処理本体をバックグラウンドで開始する。ブラウザは SSE の `GET /api/deploy/:id/logs` を購読し、永続化済みログとリアルタイムログを受信する。

処理順は次のとおり。

1. PVE API で対象 VM/CT の状態を取得し、停止中なら起動
2. SSH が利用可能になるまで最大 180 秒待機
3. Docker がなければ `get.docker.com` から導入
4. 任意でデプロイ前スナップショットを作成
5. GitHub PAT を含む一時 URL で対象ホストへ clone
6. clone 後に `origin` を削除し、PAT を対象ホストへ残さない
7. `.dashdeploy.yml` があればビルドコマンド等を上書き
8. Docker Compose または Dockerfile でビルド・起動
9. Tailscale IPv4 と公開ポートを検出
10. 最大 60 秒の HTTP ヘルスチェックを実施

GitHub PAT はログ保存・SSE 配信前に `***` へ置換される。ただし、任意のブランチ名やリポジトリ側の `.dashdeploy.yml` の扱いには追加の入力検証／信頼境界の検討余地がある。

### 3.2 復元

復元はコールドロールバックである。対象を強制停止し、台帳の `baselineSnapshot`（既定値 `clean`）へロールバックしてから再起動する。

### 3.3 設定

- `.env`: GitHub PAT、PVE API token、Tailscale API key、bind 先など
- `config/servers.local.yml`: PVE ノード名、VMID、LXC/QEMU 種別、SSH 認証、スナップショット名など
- `POST /api/settings/reload`: `.env`、PVE クライアント、台帳キャッシュを再読み込み
- `BIND_HOST` と `PORT`: listen 後には変更できないため、変更時はプロセス再起動が必要

`config/servers.local.yml` は `config/servers.yml` より優先され、`.gitignore` 対象になっている。

## 4. PVE 連携の実装

### 4.1 認証と接続

`PveClient` は次の Authorization ヘッダーを全 API 呼び出しに付与する。

```text
Authorization: PVEAPIToken=<user@realm!tokenid>=<token-secret>
```

設定元は次の環境変数。

| 変数 | 内容 |
|---|---|
| `PVE_HOST` | PVE の IP／DNS 名。カンマ区切りで複数指定可能 |
| `PVE_PORT` | 既定 `8006` |
| `PVE_TOKEN_ID` | `user@realm!tokenid` |
| `PVE_TOKEN_SECRET` | トークン作成時に一度だけ表示される secret |
| `PVE_TLS_REJECT_UNAUTHORIZED` | `true` で証明書を検証。現在の既定動作は実質 `false` |

複数の `PVE_HOST` がある場合、DNS、TCP、TLS などの接続例外が起きたときだけ次のホストへ進む。401／403／500 などの HTTP 応答を受け取った場合は、その応答を最終結果として扱い、別ホストへは切り替えない。

### 4.2 実装済み PVE 操作

| 分類 | 操作 |
|---|---|
| 読み取り | ノード、LXC、QEMU、テンプレート、ストレージ、スナップショット、状態、次の VMID |
| 電源 | start、hard stop |
| スナップショット | 作成、一覧、ロールバック |
| テンプレート | appliance catalog の一覧／ダウンロード |
| VM/CT 管理 | テンプレートからの clone、削除、CPU／メモリ変更 |
| タスク | UPID の状態をポーリングし、`exitstatus=OK` を確認 |
| IP 検出 | LXC interfaces、QEMU guest agent |

非同期タスクのタイムアウトは 5 分、ポーリング間隔は 1.5 秒。clone 後の IP 検出は約 30 秒で打ち切る。

### 4.3 テンプレートクローン

現在は、生の `vztmpl` から直接 LXC を構築する方式ではない。事前に `pct template`／`qm template` 済みのカスタムテンプレートを clone する。

画面上の既定値はリンククローン（`full=false`）。ソースコメントには、非対応ストレージで失敗したら full clone で再試行すべきとあるが、ルート／UIには自動再試行が実装されていない。clone エラーがストレージ機能に関係する場合は、まず画面で full clone を有効にして再確認する価値がある。

clone 後に起動する設定なら DHCP アドレスを検出する。LXC は PVE の interfaces API、QEMU は `qemu-guest-agent` を使用する。QEMU guest agent が利用できない場合や API が 403／500 を返した場合も、現在はすべて `null` に丸められるため、UI だけでは原因を区別できない。

## 5. 確認できた問題と改善候補

| 優先度 | 内容 | 影響／対応案 |
|---|---|---|
| 最優先 | `GET /api/settings/env` が秘密値をブラウザへ返す | README と不一致。秘密キーはマスクし、未変更時は既存値を保持する API に変更する |
| 最優先 | アプリに認証・認可がなく、PVE の削除／停止／clone API まで公開される | localhost／Tailscale ACL に限定。将来は認証、CSRF 対策、操作別認可を追加 |
| 高 | `/api/health` が PVE を確認しない | PVE の version／nodes を読む非破壊診断と、秘密を除いた段階別エラーを追加 |
| 高 | IP 検出がすべての例外を握りつぶす | agent 不在、403、404、ネットワーク障害をログ上で区別する |
| 高 | リンククローン失敗時の full clone 自動フォールバックがない | エラー理由を表示し、明示承認のうえ full clone へ再試行 |
| 高 | PVE の通常リクエストに明示的な通信タイムアウトがない | `AbortSignal.timeout` 等で接続／応答タイムアウトを設定 |
| 高 | TLS 検証無効が実質既定 | PVE CA／ACME 証明書を信頼させ、可能なら `true` を標準化 |
| 中 | PVE の実機結合テストがない | 読み取り専用 smoke test と、使い捨てゲストでの mutation test を分離して追加 |
| 中 | 依存パッケージ監査で脆弱性 11 件 | direct dependency を中心に互換性確認後アップデート |

依存監査の内訳は low 2、high 7、critical 2。直接依存では `concurrently`、`@fastify/static`、`undici`、`vite` が報告対象だった。`npm audit fix --force` の一括適用ではなく、リリースノートとビルド／テストを確認しながら個別更新するのが安全である。

## 6. 今回のローカル検証結果

### 成功

- `npm test`: 19/19 成功
- Web: TypeScript + Vite production build 成功
- Server: TypeScript build 成功
- Git 作業ツリー: 調査文書作成前は clean

テストで確認される PVE 項目は、LXC/QEMU の URL、stop／rollback、UPID 完了待ち、HTTP エラー、複数ホストフェイルオーバー、clone パラメーター、テンプレート抽出、IP 検出、next VMID である。

### 未確認

- 実際の PVE ホストへの TCP／TLS 接続
- API token の認証と ACL
- PVE 8／9 実機から返るレスポンスとの完全な互換性
- 実ストレージ上でのリンク／フル clone
- 実ゲストの start／stop／snapshot／rollback／delete
- PVE と DashDeploy が別ノードにいる場合の経路
- QEMU guest agent、Tailscale、SSH、Docker まで含む end-to-end

注: この Windows 環境では Node.js 24 用の `better-sqlite3` ネイティブビルドに Visual Studio C++ Build Tools が必要だったため、依存インストール時の lifecycle scripts を無効化して、今回の TypeScript ビルドとモックテストを実施した。本番要件は Node.js 20 以上であり、本番と同じ Linux／Node バージョンでの再確認が必要である。

## 7. PVE 実機検証の進め方

### フェーズ A: 読み取り専用

最初は PVE を変更しない専用 API token で次を順に確認する。

1. Codex を実行している端末から `<PVE_HOST>:<PVE_PORT>` へ到達できるか
2. TLS ハンドシェイクが成功するか
3. `GET /api2/json/version` で認証できるか
4. `GET /api2/json/nodes` でノード一覧を取得できるか
5. 対象ノードの LXC／QEMU／storage を列挙できるか
6. DashDeploy の `GET /api/pve/nodes` でも同じ結果になるか

この段階では start、stop、clone、snapshot、rollback、delete、設定変更を実行しない。

### フェーズ B: 対象ゲストの非破壊確認

1. 既存ゲストの `status/current` を取得
2. snapshot 一覧を取得
3. テンプレート一覧と storage の content type を確認
4. `pveNode`、`kind`、`vmid` が実体と一致するか照合
5. QEMU の場合は guest agent の有効化／稼働状況を確認

### フェーズ C: 明示承認後の変更テスト

使い捨てテンプレート、空き VMID、検証用ストレージを指定して次を実施する。

1. full clone を作成
2. clone タスクの完了を待つ
3. 起動／IP 検出
4. CPU／メモリ変更
5. snapshot 作成／rollback
6. 停止
7. 検証用 clone を削除

削除対象の node、kind、VMID、名前を実行直前に再確認する。既存の本番 VM/CT は対象にしない。

## 8. エラー別の切り分け

| 症状 | 主な確認箇所 |
|---|---|
| `ENOTFOUND` | `PVE_HOST` の DNS 名、Codex 実行端末の名前解決 |
| `ECONNREFUSED`／timeout | IP、8006、PVE proxy、FW、VLAN／VPN／Tailscale 経路 |
| certificate error | ホスト名と証明書、PVE CA、`PVE_TLS_REJECT_UNAUTHORIZED` |
| 401 | token ID の `user@realm!tokenid` 形式、secret、失効、有効期限 |
| 403 | token ACL、token の privilege separation、所有ユーザー側の権限 |
| nodes は取得できるが guests が失敗 | `/vms` の `VM.Audit`、対象ノード名 |
| template が 0 件 | `template=1` のゲストが選択ノードにあるか、`VM.Audit` |
| clone が失敗 | `VM.Clone`、`VM.Allocate`、Datastore 権限、VMID 重複、リンククローン対応 |
| clone は成功したが IP が空 | DHCP、LXC interfaces API、QEMU guest agent、30 秒タイムアウト |
| snapshot／rollback が 403 | `VM.Snapshot`、`VM.Snapshot.Rollback` |
| タスクが non-OK | PVE Tasks の同じ UPID のログを確認 |

PVE 公式ガイドによると、API token の権限は対応する所有ユーザーの権限を超えられない。privilege separation を有効にした token は token 自体への ACL も必要である。PVE ホスト側で次を確認すると切り分けやすい。

```sh
pveum user permissions <user@realm>
pveum user token permissions <user@realm> <tokenid>
```

参考: [Proxmox VE Administration Guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf)、[PVE API Viewer](https://pve.proxmox.com/pve-docs/api-viewer/)

## 9. 検証時に共有してほしい非秘密情報

次の値はチャットに記載してよい。内部情報なので必要最小限にする。

- PVE バージョン
- 単一ノードかクラスタか
- PVE API へ到達するための経路（LAN／VPN／Tailscale など）
- PVE port（8006 から変更している場合）
- 自己署名証明書か、信頼済み証明書か
- token の user／realm／token ID。secret は記載しない
- privilege separation の有効／無効
- token と所有ユーザーへ割り当てたロール／ACL パス
- 読み取り確認に使う node、kind、VMID
- 変更テストを許可する場合だけ、使い捨て template、空き VMID、storage、削除可否
- 画面またはサーバーログのエラー。token、PAT、パスワードは伏せる

PVE 読み取り検証だけなら、GitHub PAT、Tailscale API key、SSH パスワード／秘密鍵は不要である。

## 10. Codex へ認証情報を渡すベストプラクティス

### 推奨手順

1. **チャット本文へ secret を貼らない。** PVE token secret、GitHub PAT、SSH パスワード、秘密鍵本文は送信しない。
2. **検証専用 token を作る。** 最初は read-only、短い有効期限、対象パス限定、privilege separation 有効を推奨する。
3. **ユーザー自身がローカルファイルへ保存する。** このリポジトリでは `.env` が `.gitignore` 済みなので、値を自分で記入し、Codex には「設定済み」とだけ伝える。
4. **ignore を必ず確認する。** `git check-ignore .env config/servers.local.yml` で両方が表示されることを確認する。
5. **ファイル権限を絞る。** Linux なら `chmod 600 .env config/servers.local.yml`。Windows なら NTFS ACL で現在のユーザーだけに制限する。
6. **Codex の権限を最小化する。** 調査だけなら read-only、編集が必要なら workspace-write とし、ネットワークは PVE 検証時だけ許可する。
7. **秘密値を出力しない。** `Get-Content .env`、`cat .env`、`env`、`set`、デバッグログ、スクリーンショット、コマンド引数への直書きを避ける。
8. **検証終了後に token を無効化／削除する。** 漏えいの疑いがある場合は即時ローテーションする。

Codex の公式マニュアルも、ローカル実行では OS サンドボックスと承認ポリシーを併用し、権限を必要に応じて限定すること、automation secret は環境変数または secret manager でスコープを絞ることを案内している。`codex exec` の API key については、リポジトリ管理コードを実行するとき job 全体ではなく単一実行へ inline で渡すよう記載されている。

- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security.md)
- [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables.md)
- [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment.md)

Codex cloud の `Secrets` は setup script でのみ利用でき、agent phase 前に削除される。この性質上、agent phase 中に PVE API へ接続して対話的に検証する用途には向かない。今回のようなローカル Codex では、専用 token をローカルの gitignored ファイル／プロセス環境へ置き、最小権限で短時間だけ使う方法が現実的である。

### このプロジェクト固有の注意

現状の DashDeploy を起動すると、認証のない `GET /api/settings/env` から `.env` の値を取得できる。修正前に実 token を設定して起動する場合は、最低限、次を守る。

- `BIND_HOST=127.0.0.1` で検証する
- 設定画面を信頼できないブラウザ／ネットワークへ公開しない
- token は検証専用かつ短命にする
- 可能なら DashDeploy を起動せず、PVE クライアントの独立 smoke test で先に接続を確認する

## 11. 次の推奨作業

1. ユーザー側で read-only の PVE 検証用 token を作成し、ローカル `.env` へ保存
2. node／ACL／TLS などの非秘密情報だけを共有
3. Codex でフェーズ A の読み取り専用検証を実施
4. 結果に応じて設定、権限、コードのどこに問題があるか切り分け
5. `GET /api/settings/env` の secret マスキングと PVE health check を実装
6. 使い捨てゲストが用意できた場合だけフェーズ C を実施
