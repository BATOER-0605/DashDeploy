# DashDeploy Linux 作業引き継ぎ

更新日: 2026-08-02

対象リポジトリ: DashDeploy

Windows 側で確認したコミット: `99f0aaa`

Windows 側ブランチ: `claude/pve-deployment-webapp-T0Daf`

詳細な実装調査は [`IMPLEMENTATION_REVIEW.md`](./IMPLEMENTATION_REVIEW.md) を参照すること。

## 1. 現在地

- DashDeploy の現状実装、PVE 連携、既知の問題、検証計画を `IMPLEMENTATION_REVIEW.md` に整理済み。
- Windows 環境ではモックユニットテスト 19/19 件と Web／Server の TypeScript ビルドが成功した。
- PVE 実機への接続テストは未実施。
- 依存監査では low 2、high 7、critical 2 の計 11 件が報告された。更新作業は未実施。
- 最終確認時点で `.env` は dotenv 形式へ修正済み。必須 8 キーが存在し、placeholder ではなく、token ID の形式も妥当。PVE host は 2 件設定されている。値は確認・表示していない。
- サーバー台帳 YAML は誤配置されていた `server/servers.local.yml` から、正しい `config/servers.local.yml` へ移動済み。現在は `.gitignore` 対象。
- `IMPLEMENTATION_REVIEW.md` とこのファイルは未コミットの可能性があるため、Linux へ移動する前にファイルを確実にコピーまたはコミットすること。

## 2. 最重要: 秘密ファイルのLinux側への準備

当初 `.env` に入っていたサーバー台帳 YAML は分離され、最終的に `config/servers.local.yml` へ移動済み。

```text
servers
pveNode
vmid
kind
baselineSnapshot
ssh
warmTargets
```

`.env` と `config/servers.local.yml` はどちらも `.gitignore` 対象なので、GitHubへのpushには含まれない。Linux側では安全な別経路で転送するか、Linux上で新しく作成する必要がある。

Linux 環境へ引き継いだ直後に、秘密値を画面やログへ表示せず次を確認する。

```bash
# リポジトリルートで実行する。
test -f .env
test -f config/servers.local.yml

# 所有ユーザーだけが読み書きできるようにする。
chmod 600 .env config/servers.local.yml
```

古い作業コピーに `server/servers.local.yml` が残っている場合だけ、`config/servers.local.yml` が存在しないことを確認してから移動する。既存ファイルを上書きしない。

`.env` はすでに `KEY=VALUE` 形式へ修正されている。Linux 側へ安全に転送したうえで、最低限次のキーが存在することだけを確認する。

```dotenv
GITHUB_PAT=<secret>
PVE_HOST=<PVE API の IP または DNS 名>
PVE_PORT=8006
PVE_TOKEN_ID=<user@realm!tokenid>
PVE_TOKEN_SECRET=<secret>
PVE_TLS_REJECT_UNAUTHORIZED=false
BIND_HOST=127.0.0.1
PORT=3000
```

注意事項:

- secret をこのファイル、チャット、コマンド引数、ログ、スクリーンショットへ転記しない。
- `GITHUB_PAT` は PVE の読み取り自体には不要だが、現行の `server/src/config.ts` ではアプリ起動時の必須項目。
- 自己署名証明書を使う初回切り分けでは `PVE_TLS_REJECT_UNAUTHORIZED=false` が必要になる場合がある。恒久運用では PVE CA／ACME 証明書を信頼させ、`true` にすることを推奨。
- 現行アプリは認証機構がなく、`GET /api/settings/env` が秘密値をブラウザへ返す。修正前は `BIND_HOST=127.0.0.1` を使い、外部公開しない。

ignore 状態を確認する。

```bash
git check-ignore .env config/servers.local.yml
```

両方のパスが出力されればよい。`git status --short` に秘密ファイルが現れた場合は作業を止める。

## 3. Linux で最初に実行する確認

### 3.1 リポジトリ状態

```bash
git status --short
git branch --show-current
git rev-parse --short HEAD
node --version
npm --version
```

Node.js は `package.json` 上 20 以上が必要。本番に近い Node.js 20 または 22 LTS を推奨する。

### 3.2 依存関係、テスト、ビルド

```bash
npm ci
npm test
npm run build
```

期待値:

- `npm test`: 19 件成功
- Web: Vite production build 成功
- Server: TypeScript build 成功

Linux では `better-sqlite3` のインストールを含め、lifecycle scripts を無効にせず確認する。

### 3.3 設定の構文確認

Codex には、値を出力せず次だけを確認させる。

- `.env` に必須キーが存在する
- `PVE_TOKEN_ID` が `user@realm!tokenid` 形式
- placeholder 値のままではない
- `config/servers.local.yml` が YAML と inventory schema を満たす
- server name、`pveNode`、`kind`、`vmid` に重複・不整合がない
- SSH password、private key、token secret、PAT を標準出力しない

## 4. PVE 検証の順序

### フェーズ A: 読み取り専用 smoke test

最初は PVE を変更しない。Codex を実行する Linux ホストから次を確認する。

1. `PVE_HOST:PVE_PORT` の名前解決と TCP 到達性
2. TLS ハンドシェイク
3. API token 認証
4. PVE version 取得
5. node 一覧
6. 各 node の LXC／QEMU 一覧
7. storage 一覧
8. template guest 一覧
9. appliance catalog 一覧
10. cluster next VMID
11. 台帳に登録された対象の `status/current`
12. 対象の snapshot 一覧

出力してよいもの:

- 成否
- HTTP status
- node 名
- guest／storage／template の件数
- sanitized したエラーメッセージ

出力してはいけないもの:

- Authorization header
- PVE token secret
- GitHub PAT
- SSH password／private key／passphrase
- `.env` または `servers.local.yml` の全文

### フェーズ B: 非破壊のアプリ経由確認

フェーズ A が成功してから `BIND_HOST=127.0.0.1` で DashDeploy を起動し、次を確認する。

```bash
npm start
```

- `GET /api/pve/nodes`
- node ごとの guests／storage／template 表示
- `GET /api/pve/nextid`
- 設定画面に secret が返る既知問題を再確認する場合も、応答本文をログへ保存しない

`GET /api/health` は現状 GitHub PAT と inventory しか確認せず、PVE を確認しない。

### フェーズ C: 変更を伴う結合テスト

次の情報とユーザーの明示承認が揃うまで実行しない。

- 検証専用 template の node、kind、VMID
- 新規 clone に使う空き VMID
- 検証用 storage
- full clone／linked clone の選択
- 起動してよいこと
- snapshot／rollback してよいこと
- 最後に clone を削除してよいこと

承認後の推奨順序:

1. full clone
2. タスク完了待ち
3. 起動
4. IP 検出
5. CPU／メモリ変更
6. `clean` 以外の検証用 snapshot 作成
7. rollback
8. 停止
9. 対象の node、kind、VMID、名前を再確認
10. 検証用 clone のみ削除

既存の本番 VM/CT、既存 snapshot、共有 template は変更・削除しない。

## 5. PVE 連携で注視する既知ポイント

1. API token の権限は token 所有ユーザーの権限を超えられない。
2. privilege separation 有効時は token 自体への ACL も必要。
3. `pveNode` は PVE が返す実際の node 名と一致させる。
4. linked clone は storage によって失敗する。現在は full clone の自動再試行がない。
5. QEMU IP 検出には稼働中の `qemu-guest-agent` が必要。
6. IP 検出コードは現在、403／500／agent 不在などをすべて `null` に丸める。
7. PVE の通常 HTTP リクエストには明示的な応答タイムアウトがない。
8. 複数 `PVE_HOST` の切り替えは接続例外時だけ。HTTP 401／403／500 では次ホストへ進まない。

PVE ホスト側で権限を確認するときの例:

```bash
pveum user permissions <user@realm>
pveum user token permissions <user@realm> <tokenid>
```

## 6. 読み取り検証後の推奨コード修正

優先順位は次のとおり。

1. `GET /api/settings/env` から secret の平文返却を廃止
2. 設定更新 API で masked／未指定 secret は既存値を保持
3. PVE を含む read-only health／diagnostic endpoint を追加
4. PVE HTTP request timeout と sanitized error classification を追加
5. IP 検出で agent 不在、権限不足、API エラーを区別してログ出力
6. linked clone 失敗時に、ユーザー確認付きで full clone を案内
7. PVE client の実機 smoke test を通常の unit test と分離して追加
8. 認証／認可またはリバースプロキシ前提のアクセス制御を導入
9. 依存脆弱性を個別に更新して再検証

PVE 実機の事実確認とコード修正は分ける。最初から挙動を変更せず、再現したエラーと API response を secret 除去後に記録する。

## 7. 新規 Codex セッションへ渡すプロンプト

以下をそのまま新しい Linux 環境の Codex セッションへ貼り付ける。

```text
このDashDeployリポジトリについて、Windows環境からLinux環境へPVE連携検証を引き継ぎます。

最初に、リポジトリルートの以下を読んで現状を把握してください。
- LINUX_HANDOFF.md
- IMPLEMENTATION_REVIEW.md
- README.md
- CLAUDE.md

重要事項:
- .env、config/servers.local.yml、PVE token、GitHub PAT、SSH password／秘密鍵の内容をチャットやコマンド出力へ表示しないでください。
- Windows側では、誤配置されていたserver/servers.local.ymlをconfig/servers.local.ymlへ移動済みです。Linux側では.envとconfig/servers.local.ymlをGitとは別の安全な経路で用意し、git statusに秘密ファイルが現れないことを確認してください。
- .envはKEY=VALUE形式、config/servers.local.ymlはサーバー台帳YAMLであるべきです。値を表示せず、キーの存在・形式・schemaだけ検証してください。
- まずgit check-ignoreで.envとconfig/servers.local.ymlがignoreされていることを確認してください。
- BIND_HOSTは検証中127.0.0.1を使ってください。現行アプリには認証がなく、GET /api/settings/envが秘密値をブラウザへ返す既知問題があります。
- 最初はPVEを一切変更しない読み取り専用検証だけを実施してください。
- start、stop、clone、snapshot作成、rollback、delete、CPU/メモリ変更は、対象node・kind・VMID・名前を提示し、私が明示承認するまで実行しないでください。

次の順に作業してください。
1. git status、branch、HEAD、Node/npmバージョンを確認
2. 設定ファイルの配置・形式・gitignoreをsecret非表示で検証
3. npm ci、npm test、npm run buildを実行
4. LinuxホストからPVE_HOST:PVE_PORTへのDNS/TCP/TLSを確認
5. PVE API token認証を確認
6. version、nodes、guests、storage、template guests、appliance catalog、next VMID、台帳対象のstatusとsnapshot一覧を読み取り専用で確認
7. 各段階の成否、HTTP status、件数、secret除去済みエラーだけを報告
8. 問題があれば、ネットワーク、TLS、token形式、ACL、node名、storage、template、コードのどこに原因があるか切り分け

読み取り検証が完了したら、変更テストに必要な使い捨てtemplate、空きVMID、storage、許可事項を私に確認し、そこで停止してください。

コード修正は、まず実機検証結果を報告してから提案してください。修正を依頼された場合は、secret平文返却の廃止、PVE diagnostic endpoint、request timeout、エラー分類を優先してください。
```

## 8. 次のアクション

Linux 環境での直近の作業は次の 4 点。

1. このファイルと `IMPLEMENTATION_REVIEW.md` を Linux 側リポジトリへ引き継ぐ。
2. `.env` と `config/servers.local.yml` をGitとは別の安全な経路でLinux側へ用意し、ignore状態とファイル権限を確認する。
3. 上記の新規セッション用プロンプトを Codex へ渡す。
4. 読み取り専用 PVE smoke test の結果を確認してから、変更テストの対象を決める。
