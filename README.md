# DashDeploy

GitHub のリポジトリを自宅の Proxmox VE（PVE）の LXC コンテナ／QEMU VM に素早くデプロイし、
デプロイログをリアルタイムに確認し、対象機の Tailscale IP を表示し、テストが終わったら
スナップショットでクリーンな状態に復元するための、単一ユーザー向け Web アプリです。

「出先で、Claude Code で作ったリポジトリを自宅の実機で手早く試したい」というワークフローのために作られています。

## 仕組み

1. リポジトリとブランチを選ぶ（GitHub PAT を使うのでプライベートリポジトリも一覧に出ます）。
2. デプロイ先サーバをプルダウンから選ぶ（`config/servers.yml` で定義）。
3. **デプロイ** を押すと、DashDeploy は次を実行します。
   - 対象ゲストが停止していれば起動する（PVE API）
   - 任意でデプロイ前スナップショットを取得する
   - SSH で接続し、リポジトリを clone して `docker compose up -d --build`（または `Dockerfile` をビルド／実行）
   - すべてのログをブラウザにリアルタイム配信する（SSE）
   - 対象機の **Tailscale IP** と、ヘルスバッジ付きのクリック可能なアプリリンクを表示する
4. テストが終わったら **復元** を押すと、対象機をベースラインスナップショット（既定では `clean`）に
   ロールバックします（PVE API）。

デプロイ先には Docker がインストールされ、tailnet に参加していることを前提とします。
リポジトリには `Dockerfile` または `docker-compose.yml` が含まれていることを前提とします。

## 必要なもの

- Node.js 20 以上
- API トークンを発行した Proxmox VE 8 または 9 のホスト（クラスタ可）
- Docker と Tailscale を導入し、ベースラインスナップショットを作成済みの LXC／QEMU ターゲット 1 台以上
- リポジトリの読み取り／clone 権限を持つ GitHub Personal Access Token（PAT）

## セットアップ

```bash
npm run setup                       # server と web の依存関係をインストール
cp .env.example .env                # GitHub PAT と PVE トークンを記入
cp config/servers.yml config/servers.local.yml   # 実際のターゲットを記入（gitignore 対象）
npm run build                       # web と server をビルド
npm start                           # $BIND_HOST:$PORT でアプリを起動
```

開発時（ホットリロード）:

```bash
npm run dev                         # server（tsx watch）+ web（Vite が /api をプロキシ）
```

### 設定

- **`.env`** — GitHub PAT、PVE ホスト／トークン、bind ホスト／ポート。詳細は `.env.example` を参照。
- **`config/servers.local.yml`** — ターゲット台帳。存在する場合は `config/servers.yml` より優先されます。
  各エントリ: PVE ノード名、vmid、`kind`（`lxc`／`qemu`）、ベースラインスナップショット名、
  任意のアプリポート／ヘルスパス、SSH 接続情報（パスワード認証 **または** 鍵認証）。

### PVE クラスタについて

クラスタに対応しています。クラスタ内のどのノードに API リクエストを送っても、対象ゲストを
所有するノードへ自動的にプロキシされるため、`PVE_HOST` には**いずれか 1 ノード**を指定すれば
クラスタ内の全ゲストを操作できます。`PVE_HOST` はカンマ区切りで複数ノードを指定でき、
2 つ目以降は接続フェイルオーバー先として使われます。各ターゲットの `pveNode` には、
そのゲストが実際に存在するノード名を指定してください。

### 任意: リポジトリ内の `.dashdeploy.yml`

リポジトリごとに既定の Docker 動作を上書きできます。

```yaml
build: docker compose -f docker-compose.prod.yml up -d --build
appPort: 8080
healthPath: /healthz
```

## スナップショットと復元

- 各ターゲットには、あらかじめ「クリーンな状態」のスナップショット（既定名 `clean`）を
  作成しておきます。
- **復元** は次の手順で行われます（コールドスナップショット復元）。
  1. 対象ゲストが稼働中ならパワーオフする
  2. パワーオフ完了を待つ
  3. ベースラインスナップショットをロールバックする
- デプロイ時に「デプロイ前スナップショット」を有効にすると、その時点のスナップショットも
  別途作成されます。

## セキュリティ

- DashDeploy は単一ユーザー向けで**認証機構はありません**。自宅の PVE 上で動かし、
  Tailscale インターフェースに bind（`BIND_HOST`）して tailnet 内からのみ到達可能に
  してください。**インターネットには公開しないでください。**
- シークレット（`.env`、`config/servers.local.yml`、`data/`）は gitignore 対象です。
  コミットされるのはサニタイズ済みの `config/servers.yml` と `.env.example` のみです。
- GitHub PAT と PVE トークンはブラウザに送られません。`/api/servers` はサニタイズ済みです。
  PAT はログ行を保存・配信する前にマスクされます。
- PVE トークンは最小権限にしてください: 対象ゲストに対する `VM.Audit`、`VM.PowerMgmt`、
  `VM.Snapshot`、`VM.Snapshot.Rollback`。
- `PVE_TLS_REJECT_UNAUTHORIZED=false` は自宅 PVE の自己署名証明書向けの既定値です。

## ヒント

- **LXC ターゲットは QEMU VM より起動・ロールバックが大幅に高速**です。素早い反復には LXC を
  推奨し、カーネルレベルの要件がある場合のみ VM を使ってください。
- 台帳の `warmTargets` は、起動しっぱなしにしているゲストを記録するためのものです（起動ステップを省略できます）。
- 履歴テーブルの **再デプロイ** ボタンで、過去のデプロイをワンクリックで再実行できます。

## テスト

```bash
npm test        # server のユニットテスト（PVE クライアント、ログ行スプリッタ）
```

## 手動の結合テスト チェックリスト

- [ ] 停止中のターゲットにデプロイ — 自動起動する
- [ ] 「デプロイ前スナップショット」を有効にしてデプロイ — スナップショットが作成される
- [ ] パスワード認証のターゲットと鍵認証のターゲットにデプロイ
- [ ] LXC ターゲットと QEMU ターゲットにデプロイ
- [ ] 成功時に Tailscale IP とクリック可能なアプリリンクが表示される
- [ ] デプロイ途中でページをリロード — SSE ログストリームが再生され、継続する
- [ ] 履歴テーブルから再デプロイ
- [ ] 復元 — ターゲットがパワーオフされ、ベースラインスナップショットにロールバックされる
- [ ] PVE クラスタ環境で、別ノード上のゲストにデプロイ／復元できる
- [ ] `GET /api/health` が GitHub と台帳の状態を OK と報告する
