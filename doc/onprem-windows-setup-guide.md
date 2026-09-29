# DevRelay 社内オンプレ構築手順書（Windows Server ネイティブ）

`doc/service-setup-guide.md`（VPS/Ubuntu 向け）の社内 Windows Server 版。
現行 `devrelay.io`（VPS）とは**別インスタンス・別 DB**として新規構築する。データ移行は行わない。

## 前提・スコープ

- **testflight / DevRelay Sites は使わない**（`sudo`/`systemctl`/Caddy 前提のため Windows では動かない）
- **Discord / Telegram は使わない**（WebUI 専用運用）
- **社内プロキシ経由でのみ外部 HTTPS に出られる**（完全閉域ではない）
- PostgreSQL + pgvector は**社内に既存のインスタンスへ相乗り**（新規に建てない）
- 社内で使う AI CLI（Claude Code / Gemini CLI / Devin いずれも）は外部 API への HTTPS が必須。
  社内プロキシの許可先リストは Anthropic / OpenAI / Google / Devin の全エンドポイントを含めること

---

## 事前に決めておくこと

| 項目 | 記入欄 | 例 |
|---|---|---|
| 社内ドメイン | __________ | devrelay.corp.example |
| DevRelay 用 DB 名 | __________ | devrelay |
| DevRelay 用 DB ロール | __________ | devrelay_user |
| Server ポート | __________ | 3005 |
| コード配置先 | __________ | C:\devrelay |
| サービス化方式 | __________ | NSSM |

---

## Step 1: Node.js / pnpm

1. [Node.js 20 LTS](https://nodejs.org/)（MSI インストーラ）を導入
2. `corepack enable` で pnpm を有効化（`corepack prepare pnpm@10 --activate` 等バージョン固定推奨）
3. `git` を導入（Git for Windows）

確認:
```powershell
node -v   # v20.x
pnpm -v
git --version
```

- [ ] node/pnpm/git が使える

---

## Step 2: リポジトリ取得・依存インストール

```powershell
git clone https://github.com/murata1215/devrelay.git C:\devrelay
cd C:\devrelay

# ルートで pnpm install すると agents/windows（Electron）等まで対象になるため、
# サーバー運用に不要なパッケージも含めて依存解決される点に注意（ビルドは --filter で絞る、Step 4 参照）
pnpm install
```

- [ ] `pnpm install` が完了する

---

## Step 3: PostgreSQL に DevRelay 専用 DB を作成

**前提: 社内 PostgreSQL インスタンスに pgvector 拡張のバイナリが導入済みであること。**
`CREATE EXTENSION vector` 自体は DB 単位の操作であり、サーバーにバイナリが入っていても
DevRelay 用に新しく作る DB の中では改めて実行が必要。**pgvector は trusted extension ではないため
superuser 権限が要る**（社内 DBA への依頼、または一時的な superuser 付与が必要）。

```sql
-- superuser または DBA 実行
CREATE ROLE devrelay_user WITH LOGIN PASSWORD '<強いパスワード>';
CREATE DATABASE devrelay
  OWNER devrelay_user
  ENCODING 'UTF8'
  TEMPLATE template0;
  -- 注意: 現行 VPS は LC_COLLATE='C.UTF-8' だが、Windows には C.UTF-8 ロケールが無いため
  -- LC_COLLATE の明示指定はせず、インスタンス既定（または ICU プロバイダ）に任せること。
  -- ENCODING 'UTF8' は必須。

\c devrelay
CREATE EXTENSION vector;  -- superuser 権限が必要
```

- [ ] `devrelay` DB と `devrelay_user` ロールを作成した
- [ ] `\dx` で `vector` 拡張が有効になっていることを確認した

---

## Step 4: `.env` 作成とビルド

`apps/server/.env.example` を `apps/server/.env` にコピーし、以下を必ず設定する:

| 変数 | 値の目安 |
|---|---|
| `DATABASE_URL` | `postgresql://devrelay_user:<パスワード>@<DBホスト>:5432/devrelay` |
| `PORT` / `HOST` | `3005` / `0.0.0.0` |
| `SETTINGS_ENCRYPTION_KEY` | `openssl rand -hex 32` 等で新規生成（**後から変更しないこと**。変更すると既存の暗号化済み設定が復号不能になる） |
| `HTTPS_PROXY` | 社内プロキシの URL（外部 HTTPS に出るために必須） |
| `DEVRELAY_SYSTEM_ADMIN_EMAILS` | 管理者メールアドレス（カンマ区切り） |
| `DEVRELAY_TESTFLIGHT` | `0`（無効化。sudo/Caddy 前提のため） |
| `DEVRELAY_SITES_HEALTH` | `0`（無効化） |
| `DEVRELAY_SITES_ACCESS_LOG` | `0`（無効化） |
| `DEVRELAY_SERVICE_RESTART_CMD` | Step 7 のサービス化方式に合わせて設定（例: `nssm restart DevRelayServer`） |
| `DEVRELAY_SERVICE_STATUS_CMD` | 同上（例: `sc query DevRelayServer`） |

DB スキーマ作成（`prisma/migrations/` だけでは pgvector 関連オブジェクトが作られないため、
`db:bootstrap` を使うこと。詳細は `apps/server/prisma/bootstrap.sql` のコメント参照）:

```powershell
cd C:\devrelay
pnpm --filter @devrelay/shared build
cd apps\server
pnpm db:bootstrap
```

ビルド（社内サーバーではサーバー運用に必要なパッケージだけに絞る）:

```powershell
cd C:\devrelay
pnpm --filter @devrelay/shared --filter @devrelay/server --filter @devrelay/web build
```

- [ ] `.env` を作成し、上表の項目をすべて埋めた
- [ ] `pnpm db:bootstrap` が成功した（`information_schema.columns` で `MessageFile.embedding` /
      `AgentDocument.embedding` の存在を確認するとなお良い）
- [ ] ビルドが成功する

---

## Step 5: 動作確認（フォアグラウンド起動）

```powershell
cd C:\devrelay\apps\server
node dist\index.js
```

- [ ] 起動ログに `SETTINGS_ENCRYPTION_KEY` 未設定警告が出ない（＝設定済み）
- [ ] 起動ログに testflight/sites 無効化のログが出る
- [ ] `HTTPS_PROXY` を設定した場合、`🌐 プロキシ経由で外向き通信します` ログが出る
- [ ] `http://localhost:3005/health` が `{"status":"ok",...}` を返す

問題なければ `Ctrl+C` で停止し、次のステップへ。

---

## Step 6: リバースプロキシ（Caddy for Windows）

**Fastify 側に静的配信の実装は無い**ため、WebUI（`apps/web/dist`）の配信にはリバースプロキシが必須。
`apps/web/vite.config.ts` の `base: '/'` と PWA の `start_url` により**サブパス配信は不可**
（社内ドメインはルートで配信すること）。

[Caddy for Windows](https://caddyserver.com/download?package=windows-amd64) を導入し、
`doc/service-setup-guide.md` の `app.devrelay.io` ブロックと同じ構成を社内ドメインに適用する
（`/api/*`, `/ws/*`, `/mcp`, `/.well-known/*`, `/oauth/*` を `localhost:3005` へ、それ以外を
`apps/web/dist` の静的配信 + SPA フォールバックへ）。TLS は社内 CA 証明書、または `tls internal`
（自己署名。ブラウザに警告が出るため社内 CA 推奨）。

- [ ] Caddy for Windows が起動し、社内ドメインで WebUI が表示される
- [ ] `/api/health` 相当が Server 経由で応答する

---

## Step 7: Windows サービス化

[NSSM](https://nssm.cc/) を使う例:

```powershell
nssm install DevRelayServer "C:\Program Files\nodejs\node.exe" "C:\devrelay\apps\server\dist\index.js"
nssm set DevRelayServer AppDirectory "C:\devrelay\apps\server"
nssm set DevRelayServer AppStdout "C:\devrelay\logs\server.log"
nssm set DevRelayServer AppStderr "C:\devrelay\logs\server.log"
nssm start DevRelayServer
```

`.env` の `DEVRELAY_SERVICE_RESTART_CMD` / `DEVRELAY_SERVICE_STATUS_CMD` を対応するコマンド
（`nssm restart DevRelayServer` / `sc query DevRelayServer` 等）に設定し、WebUI の
サービス再起動ボタン（システム管理者限定）が機能することを確認する。

- [ ] サービスとして起動・自動起動設定が完了している
- [ ] WebUI からサービス再起動を実行し、正常に反映される

---

## Step 8: Agent 配布

Agent 側は**コード変更不要**。社内 WebUI のエージェント作成画面でトークンを発行すると、
接続先サーバー URL がトークンに自動で埋め込まれる（`packages/shared/src/token.ts`）ため、
社内端末で以下を実行するだけで社内サーバーに接続する。

```powershell
# Windows 端末
$env:DEVRELAY_TOKEN="<社内 WebUI で発行したトークン>"
$env:DEVRELAY_PROXY="http://proxy.corp.example:8080"  # 社内プロキシ経由が必要な場合
irm https://<社内ドメイン>/install-agent.ps1 | iex
```

```bash
# Linux/macOS 端末
curl -fsSL https://<社内ドメイン>/install-agent.sh | bash -s -- --token "<トークン>" --proxy "http://proxy.corp.example:8080"
```

- [ ] 社内端末の Agent が接続でき、WebUI 上でオンラインと表示される

---

## 既知の制約（社内インスタンスでは使えない機能）

| 機能 | 理由 |
|---|---|
| Google OAuth ログイン | Google 側が公開 TLD の HTTPS リダイレクト URI を要求するため。ローカル email+password 認証を使う |
| Claude.ai の MCP コネクタ | Anthropic クラウドからの inbound が必要なため。社内から PAT で `/mcp` を叩く用途は可 |
| Discord / Telegram | 未設定のため自動無効化（意図的） |
| testflight / DevRelay Sites | `DEVRELAY_TESTFLIGHT=0` / `DEVRELAY_SITES_HEALTH=0` / `DEVRELAY_SITES_ACCESS_LOG=0` で無効化 |

## テストに関する既知事項

`apps/server/tests/` のうち `sites-uu-secret.test.mjs` / `sites-access-reader.test.mjs` は
実ファイルシステムの file mode / inode を検証するため、Windows 上では失敗する場合がある
（本番稼働の testflight/sites 無効化構成には無関係）。
