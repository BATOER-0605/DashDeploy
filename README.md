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
   - **Docker が入っていなければ自動でインストール**する（`get.docker.com`、初回のみ）
   - 任意でデプロイ前スナップショットを取得する
   - SSH で接続し、リポジトリを clone して `docker compose up -d --build`（または `Dockerfile` をビルド／実行）
   - すべてのログをブラウザにリアルタイム配信する（SSE）
   - 対象機の **Tailscale IP** と、ヘルスバッジ付きのクリック可能なアプリリンクを表示する
4. テストが終わったら **復元** を押すと、対象機をベースラインスナップショット（既定では `clean`）に
   ロールバックします（PVE API）。

デプロイ先には **Tailscale がインストールされ tailnet に参加していること**、SSH ユーザーが
**root であるか、もしくはパスワードなしで `sudo` を実行できること** を前提とします。Docker は
初回デプロイ時に自動でインストールされるため、事前準備は不要です。
リポジトリには `Dockerfile` または `docker-compose.yml` が含まれていることを前提とします。

## 必要なもの

- Node.js 20 以上
- API トークンを発行した Proxmox VE 8 または 9 のホスト（クラスタ可）
- LXC／QEMU ターゲット 1 台以上。**事前に必要なのは Tailscale 導入とベースラインスナップショット
  （`clean`）のみ**。SSH ユーザーは root であるか、`sudo` を**パスワードなし**で実行できること
  （`/etc/sudoers.d/<user>` に `<user> ALL=(ALL) NOPASSWD:ALL` 等）。Docker はデプロイ時に自動導入
- リポジトリの読み取り／clone 権限を持つ GitHub Personal Access Token（PAT）

## セットアップ

### 推奨: `./setup.sh`（systemd サービスとして常駐させる）

ホスト（DashDeploy 本体を動かす LXC/VM）で **一般ユーザ権限** にて次を実行します。

```bash
./setup.sh
```

このスクリプトは:
1. Node.js のバージョンを確認（>= 20）
2. `.env` が無ければ `.env.example` からコピーし、編集を促して終了します。
   2 回目の実行で続きが進みます。
3. `npm run setup` と `npm run build` を実行
4. `/etc/systemd/system/dashdeploy.service` を生成・配置（`sudo` を要求します）
5. サービスを **有効化（OS 起動時に自動起動。ユーザログイン不要）** して起動

systemd サービスとして登録されるため、ホストを再起動しても自動的に立ち上がります。
よく使うコマンド:

```bash
sudo systemctl status dashdeploy.service   # 状態確認
journalctl -u dashdeploy.service -f        # ライブログ
sudo systemctl restart dashdeploy.service  # 再起動
sudo systemctl stop dashdeploy.service     # 停止
sudo systemctl disable dashdeploy.service  # 自動起動の無効化
```

### 手動で動かす場合

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

リポジトリごとに既定の Docker 動作を上書きできます。`$SUDO` は DashDeploy が事前定義する
変数（非 root の場合は `sudo`、root の場合は空文字）なので、自分のビルドコマンドでも利用できます。

```yaml
build: $SUDO docker compose -f docker-compose.prod.yml up -d --build
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
  4. ゲストをパワーオンする
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
- [ ] 復元 — ターゲットがパワーオフされ、ベースラインスナップショットにロールバックされ、再度パワーオンされる
- [ ] PVE クラスタ環境で、別ノード上のゲストにデプロイ／復元できる
- [ ] `GET /api/health` が GitHub と台帳の状態を OK と報告する
