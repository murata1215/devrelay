# DevRelay 社内オンプレ構築手順書（Windows Server ネイティブ）

`doc/service-setup-guide.md`（VPS/Ubuntu 向け）の社内 Windows Server 版。
現行 `devrelay.io`（VPS）とは**別インスタンス・別 DB**として新規構築する。データ移行は行わない。

## 前提・スコープ

- **testflight / DevRelay Sites は使わない**（`sudo`/`systemctl`/Caddy 前提のため Windows では動かない）
- **Discord / Telegram は使わない**（WebUI 専用運用）
- 外部 HTTPS 接続（AI API 等）は、インターネット直結・社内プロキシ経由のいずれでも対応可能
  （後述「プロキシ設定」節）
- PostgreSQL + pgvector は**社内に既存のインスタンスへ相乗り**（新規に建てない）
- 社内で使う AI CLI（Claude Code / Gemini CLI / Devin いずれも）は外部 API への HTTPS が必須

---

## ⚠️ 導入先が「空きマシン」ではない場合の第一制約

社内サーバーは多くの場合、**他の業務システムが既に稼働中の共用ホスト**に相乗りすることになる
（実例: 社内サイネージ IIS サイト + pm2 の本番アプリ4本が稼働中のホストに DevRelay を追加した
ケース）。この場合、**既存稼働への非干渉を公開方式・サービス化方式の決定より上位の制約**として扱う。

導入前に必ず確認すること:

- [ ] 80/443 番ポートの使用状況（`netstat -ano | findstr :80` / `:443`）。IIS や他社製 Web サーバーが
      既に握っている場合、**Caddy を 80/443 で起動してはいけない**（既存サイトが即停止する）
- [ ] pm2 が既に動いているか（`pm2 list`）。動いていれば**その pm2 デーモンには DevRelay を登録
      しない**（別デーモンの `dump.pm2` を巻き込む事故を避ける。後述）
- [ ] グローバル Node.js のバージョンと、それを使っている既存プロセスの有無
      （`node -v`、`pm2 list` の各プロセスが使う node）。**既存本番が依存している場合、
      グローバル Node を差し替えない**
- [ ] Windows Defender / EDR（Tanium 等）の除外設定が必要か（`node_modules` 配下は
      ファイル数が多く、リアルタイムスキャンで install/build が大幅に遅くなる）
- [ ] DevRelay 用に使える空きポート（`netstat -ano` で未使用の 1 つを選ぶ。本手順書は以後
      例として `3000` を使う）

**このセクションの確認結果次第で、下記 Step 6（公開方式）・Step 7（サービス化）の選択が変わる。**
空きマシンに新規構築する場合は従来どおり Caddy + 3005 で問題ない。

---

## 事前に決めておくこと

| 項目 | 記入欄 | 例 |
|---|---|---|
| 社内ドメイン | __________ | devrelay.corp.example |
| DevRelay 用 DB 名 | __________ | devrelay |
| DevRelay 用 DB ロール | __________ | devrelay_user |
| Server ポート | __________ | 3000（既存プロセスと衝突しない空きポート） |
| コード配置先 | __________ | C:\devrelay |
| 公開方式 | __________ | Caddy（専用ホスト） / IIS+ARR（既存稼働ホストに相乗り） |
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

### すでにグローバル Node が入っている場合（他プロセスと共用のホスト）

既存本番プロセスが別バージョンの Node（例: v24 系）に依存している場合、グローバル Node を
Node 20 で上書きしてはいけない。**公式 zip を `C:\node20` 等へ side-by-side 展開し、
NSSM の実行ファイル指定（Step 7）だけそちらを指す**。PATH とグローバル `node` コマンドは
一切変更しない。

さらに、**Prisma 5.x は比較的新しい Node メジャーバージョン（v22/v24 系）を想定していない
世代**のため、グローバル Node が新しい場合は `pnpm install` 後に
`npx prisma generate` が実際に通るかを Step 4 で明示的に確認すること。失敗する場合は
side-by-side の Node 20/22 を使ってビルド・起動する。

---

## Step 2: リポジトリ取得・依存インストール

Windows では git の既定設定で改行コード変換（CRLF）が有効な場合があり、リポジトリ内の
シェルスクリプト（`scripts/*.sh`）が壊れることがある。**`core.autocrlf=false` を明示**すること
（`git config --system --get core.autocrlf` で `true` になっていないか事前確認推奨）。

```powershell
git clone --config core.autocrlf=false https://github.com/murata1215/devrelay.git C:\devrelay
cd C:\devrelay

# ルートで pnpm install すると agents/windows（Electron、~100MB超）等まで対象になるため、
# サーバー運用に不要なパッケージも含めて依存解決される。--filter で必要な3パッケージに絞る。
pnpm install --filter @devrelay/shared... --filter @devrelay/server... --filter web...
```

- [ ] `pnpm install` が完了する
- [ ] （Node のメジャーバージョンが新しい場合）`cd apps\server && npx prisma generate` が
      エラー無く完了する。失敗する場合は Step 1 の side-by-side Node に切り替える

### `onlyBuiltDependencies` の競合に注意

`.npmrc`（`onlyBuiltDependencies=[]`）と `pnpm-workspace.yaml`（空）と
ルート `package.json` の `pnpm.onlyBuiltDependencies`（`@prisma/client` 等を列挙）の
3 箇所で定義が競合している。環境によって空配列側が勝つと Prisma の postinstall
（query engine の生成）が走らない場合があるため、上記の `npx prisma generate` 確認を
必ず行うこと。

---

## Step 3: PostgreSQL に DevRelay 専用 DB を作成

**前提: 社内 PostgreSQL インスタンスに pgvector 拡張のバイナリが導入済みであること。**
`CREATE EXTENSION vector` 自体は DB 単位の操作であり、サーバーにバイナリが入っていても
DevRelay 用に新しく作る DB の中では改めて実行が必要。**pgvector は trusted extension ではないため
superuser 権限が要る**（社内 DBA への依頼、または一時的な superuser 付与が必要）。

既存アプリと同一の PostgreSQL インスタンスに相乗りする場合は、**DB 名・ロール名が既存と
衝突しないこと**を事前に DBA へ確認する。

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

既存インスタンスに他の本番アプリが同居している場合は、Prisma の接続プールが既存アプリを
圧迫しないよう `DATABASE_URL` に `connection_limit` を明示するのを推奨する（Step 4）。

本番 devrelay.io の pgvector は 0.6.0 だが、社内インスタンスにそれより新しいバージョン
（0.8.1 等）が入っていても `bootstrap.sql` の `ivfflat (vector_cosine_ops)` は互換動作する。

- [ ] `devrelay` DB と `devrelay_user` ロールを作成した（既存 DB/ロール名と衝突していない）
- [ ] `\dx` で `vector` 拡張が有効になっていることを確認した

---

## Step 4: `.env` 作成とビルド

`apps/server/.env.example` を `apps/server/.env` にコピーし、以下を必ず設定する:

| 変数 | 値の目安 |
|---|---|
| `DATABASE_URL` | `postgresql://devrelay_user:<パスワード>@<DBホスト>:5432/devrelay?connection_limit=5`（既存インスタンス相乗り時は接続数を絞る） |
| `PORT` / `HOST` | 事前に決めた空きポート（例 `3000`） / `127.0.0.1`（リバースプロキシの背後に隠す場合。外部に直接晒す場合は `0.0.0.0`） |
| `SETTINGS_ENCRYPTION_KEY` | `openssl rand -hex 32` 等で新規生成（**後から変更しないこと**。変更すると既存の暗号化済み設定が復号不能になる） |
| `PUBLIC_URL` | `https://<社内ドメイン>`（**未設定だと `https://app.devrelay.io` にフォールバックする**。MCP の OAuth issuer/metadata に使われるため必ず設定） |
| `DEVRELAY_SYSTEM_ADMIN_EMAILS` | 管理者メールアドレス（カンマ区切り。**未設定だと全員が非管理者**になり、サービス再起動ボタン等の管理者限定機能が全て 403 になる） |
| `DEVRELAY_TESTFLIGHT` | `0`（無効化。sudo/Caddy 前提のため。既存稼働ホストでは特に重要。後述） |
| `DEVRELAY_SITES_HEALTH` | `0`（無効化） |
| `DEVRELAY_SITES_ACCESS_LOG` | `0`（無効化） |
| `DEVRELAY_SERVICE_RESTART_CMD` | Step 7 のサービス化方式に合わせて設定（例: `nssm restart devrelay-server`） |
| `DEVRELAY_SERVICE_STATUS_CMD` | 同上（例: `nssm status devrelay-server`） |

### `DEVRELAY_TESTFLIGHT=0` が特に重要な理由（既存稼働ホストの場合）

`services/testflight-manager.ts` は `pm2 start` / `pm2 delete` / **`pm2 save`** を実行する。
既存ホストの pm2 デーモンに他の本番プロセスが登録されている場合、`pm2 save` が走ると
その pm2 デーモンの `dump.pm2`（再起動時の復元リスト）が意図せず上書きされる。
**DevRelay を既存 pm2 デーモンに一切触らせないために、無効化は必須。**

### プロキシ設定（環境による）

`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` は `services/proxy-dispatcher.ts` が読み、設定されていれば
undici の `globalDispatcher` にプロキシを登録する。**インターネットに直結できる環境では
これらは未設定のままで良い**（何もしない＝fail-soft）。

社内プロキシ経由でのみ外部 HTTPS に出られる環境では、`.env` に設定する:
```env
HTTPS_PROXY=http://proxy.corp.example:8080
```

**注意（Windows の Machine スコープ環境変数と dotenv の優先順位）**:
`index.ts` は `import 'dotenv/config'` を使っており、**dotenv は既定で既存の `process.env` を
上書きしない**。Windows の Machine（システム）スコープに `HTTP_PROXY`/`HTTPS_PROXY` が
既に設定されているホストでは、**`.env` に空値や別の値を書いても無効**（Machine スコープの
値が勝つ）。このようなホストでプロキシを使わない／別のプロキシにしたい場合は、
`.env` ではなく **NSSM のプロセス環境変数**で上書きする必要がある（Step 7 参照）。

また `NO_PROXY` は値として読み取られるが、**ホスト単位の除外は実装されていない**
（警告ログのみで全通信がプロキシ経由になる）。`HTTP_PROXY` まで設定すると、ローカルの
管理 API（例: Caddy admin `127.0.0.1:2019`）宛の通信までプロキシに流れる可能性があるため、
**`HTTPS_PROXY` のみを設定するのを推奨**する。

DB スキーマ作成（`prisma/migrations/` だけでは pgvector 関連オブジェクトが作られない上、
**migrations 自体が最新の `schema.prisma` に対して古い**ため、`prisma migrate deploy` は
使用しないこと。必ず `db:bootstrap` を使う。詳細は `apps/server/prisma/bootstrap.sql` のコメント参照）:

```powershell
cd C:\devrelay
pnpm --filter @devrelay/shared build
cd apps\server
pnpm db:bootstrap
```

ビルド（社内サーバーではサーバー運用に必要なパッケージだけに絞る）:

```powershell
cd C:\devrelay
pnpm --filter @devrelay/shared build
pnpm --filter @devrelay/server --filter web build
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
- [ ] プロキシを使わない構成の場合、`🌐 プロキシ経由で外向き通信します` ログが**出ない**
      （出ている場合は Machine スコープの `HTTP_PROXY`/`HTTPS_PROXY` が勝っている。
      上記「プロキシ設定」節を参照して NSSM 側で上書きする）
- [ ] `http://127.0.0.1:<PORT>/health` が `{"status":"ok",...}` を返す

問題なければ `Ctrl+C` で停止し、次のステップへ。

---

## Step 6: リバースプロキシ

**Fastify 側に静的配信の実装は無い**ため、WebUI（`apps/web/dist`）の配信にはリバースプロキシが必須。
公開方式は、冒頭「導入先が空きマシンでない場合の第一制約」の確認結果に応じて以下の
3 パターンから選ぶ。

`apps/web` はビルド時に `DEVRELAY_WEB_BASE` を与えることでサブパス配信（例
`https://host/foo/devrelay/`）にも対応する（未指定ならルート配信で従来どおり）。
既存サイトが 80/443 を占有していて新規ホストヘッダ（＝DNS / ELB の追加作業）が
取れない環境では、**パターン C が最も外部依存が少ない**。

### パターン A: 専用ホスト・80/443 が空いている場合（Caddy）

[Caddy for Windows](https://caddyserver.com/download?package=windows-amd64) を導入し、
`doc/service-setup-guide.md` の `app.devrelay.io` ブロックと同じ構成を社内ドメインに適用する
（`/api/*`, `/ws/*`, `/mcp`, `/.well-known/*`, `/oauth/*` を `localhost:<PORT>` へ、それ以外を
`apps/web/dist` の静的配信 + SPA フォールバックへ）。TLS は社内 CA 証明書、または `tls internal`
（自己署名。ブラウザに警告が出るため社内 CA 推奨）。

- [ ] Caddy for Windows が起動し、社内ドメインで WebUI が表示される
- [ ] `/api/health` 相当が Server 経由で応答する

### パターン B: 既存稼働ホストに相乗り・80/443 が IIS 等に占有されている場合（IIS + ARR）

**Caddy を 80/443 で起動してはいけない**（既存サイトが停止する）。代わりに、既存 IIS に
**新規サイトをホストヘッダ別で追加**し、IIS 標準の Application Request Routing（ARR）を
リバースプロキシとして使う。多くの環境では ARR + URL Rewrite が既に有効化されている
（既存サイトが ARR で他プロセスへプロキシしている場合は特に）。未導入なら
`Microsoft Web Platform Installer` 等で `Application Request Routing` と
`URL Rewrite` モジュールを追加する。

事前確認:
- [ ] IIS に新規サイトを追加できる空きホストヘッダがある（例 `devrelay.internal.corp.example`）。
      **これには社内 ELB／ロードバランサ側のホストベースルーティング追加が必要なことが多く、
      ネットワーク担当への依頼が先行作業になる**
- [ ] `Web-WebSockets`（WebSocket Protocol）Windows 機能が導入済みか確認する
      （`Get-WindowsFeature Web-WebSockets`）。**未導入の場合、後から追加導入すると
      IIS（W3SVC）の再起動が発生し、同じ IIS 上の既存サイトが一瞬停止する**。
      メンテナンス時間を確保してから導入すること

IIS 側の `web.config`（新規サイトの物理パスを `apps/web/dist` と同じ内容にし、そこに配置する）は
現行 Caddyfile の契約を移植する: `/api/*` `/ws/*` `/mcp` `/.well-known/*` `/oauth/*` を
ARR で `http://127.0.0.1:<PORT>/` にリライトし、それ以外は静的配信 + SPA フォールバック
（`/index.html`）。加えて IIS は未知の拡張子を 404 にするため、
`manifest.webmanifest`（`application/manifest+json`）の MIME 登録を忘れないこと。
雛形は社内導入時にランブックとして別途生成する。

- [ ] IIS の新規サイトが起動し、社内ドメインで WebUI が表示される
- [ ] `/api/health` 相当が Server 経由で応答する
- [ ] WebSocket（Agent 接続・チャットのリアルタイム更新）が通る（Agent 追加後に確認）

### パターン C: 既存サイトのサブパスに相乗りする場合（IIS + ARR / ホストヘッダ追加なし）

既存サイトの URL 空間の一部として配信する（例 `https://service.example.co.jp/tsinternal/devrelay/`）。
**DNS・ELB・TLS 証明書の追加作業が一切不要**で、既存サイトの HTTPS をそのまま使える。
さらに IIS サイトも仮想ディレクトリも作らない（`applicationHost.config` を変更しない）ため、
**既存アプリケーションの再起動が発生しない**のが最大の利点。パターン B のホストヘッダ追加が
ネットワーク担当の作業待ちになる環境では、こちらを先に立ち上げて評価できる。

手順:

1. 既存サイトの物理パス配下に配信用フォルダを作る（例 `D:\tsinternal\devrelay\`）
2. サブパスを指定して WebUI をビルドし、成果物をコピーする

```powershell
cd C:\devrelay
$env:DEVRELAY_WEB_BASE = "/tsinternal/devrelay"
pnpm -F web build
Copy-Item C:\devrelay\apps\web\dist\* D:\tsinternal\devrelay\ -Recurse -Force
```

3. そのフォルダに `web.config` を置く（`dist` に含まれないのでコピーで消えない）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="devrelay-backend" stopProcessing="true">
          <match url="^(api|ws|mcp|oauth|health|\.well-known)(/.*)?$" />
          <action type="Rewrite" url="http://localhost:3000/{R:0}" />
        </rule>
        <rule name="devrelay-spa" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="index.html" />
        </rule>
      </rules>
    </rewrite>
    <staticContent>
      <remove fileExtension=".webmanifest" />
      <mimeMap fileExtension=".webmanifest" mimeType="application/manifest+json" />
    </staticContent>
  </system.webServer>
</configuration>
```

4. `.env` の `PUBLIC_URL` をサブパス込みの URL にする
   （例 `PUBLIC_URL=https://service.example.co.jp/tsinternal/devrelay`）

実機で踏んだ注意点:

- **フォルダ階層の `web.config` では `<match url>` がそのフォルダからの相対 URL にマッチする。**
  したがって `{R:0}` で転送するとプレフィックスが自然に剥がれ、Fastify が期待する `/api/...`
  の絶対パスに戻る。既存の Express 系アプリ（`kitei` 等）がプレフィックスを剥がさずに
  転送しているのとは逆になる点に注意（Fastify 側はルートが絶対パス固定で、かつ静的配信を
  持たないため、静的ファイルは IIS が直接配信し、API だけを剥がして渡す形になる）
- **`.webmanifest` の MIME 登録が無いと PWA マニフェストが 404.3 になる。**
- **XML コメント内にハイフン 2 連（`--`）を書くと 500.19（エラーコード `0x8007000d`）で
  そのフォルダ配下が全滅する。** デプロイコマンドを `web.config` のコメントに残す場合は
  `pnpm -F` のような短縮形で書くこと
- IIS WebSocket 機能が無効だと ARR が WebSocket を中継できず、Agent 接続が通らない
  （パターン B と同じ。導入時に W3SVC 再起動が発生するためメンテナンス枠が必要）
- 機械レベルの ARR タイムアウトは既定 `00:02:00`。長時間アイドルする WebSocket が
  切断される可能性があるため、必要なら ARR のプロキシタイムアウトを延ばす

- [ ] `https://<既存ホスト>/<サブパス>/` で WebUI が表示される
- [ ] `/<サブパス>/health` が `{"status":"ok"}` を返す
- [ ] `/<サブパス>/manifest.webmanifest` が `application/manifest+json` で 200 を返す
- [ ] `/<サブパス>/chat` 等の SPA ルートが 200（`index.html` フォールバック）になる
- [ ] `wss://<既存ホスト>/<サブパス>/ws/web` が `101 Switching Protocols` になる
- [ ] 既存サイトが引き続き正常応答する（相乗り先のアプリを必ず確認する）

---

## Step 7: Windows サービス化

[NSSM](https://nssm.cc/) を使う例:

```powershell
nssm install devrelay-server "C:\Program Files\nodejs\node.exe" "C:\devrelay\apps\server\dist\index.js"
nssm set devrelay-server AppDirectory "C:\devrelay\apps\server"
nssm set devrelay-server AppStdout "C:\devrelay\logs\server.log"
nssm set devrelay-server AppStderr "C:\devrelay\logs\server.log"
nssm start devrelay-server
```

**既存 pm2 デーモンがホスト上で稼働中の場合、DevRelay をそこに登録してはいけない**
（別デーモンの `dump.pm2` を巻き込む・Administrator の対話ログオン依存で自動復帰が
機能しないことがある）。NSSM による独立した Windows サービス化を推奨する。

Machine スコープの `HTTP_PROXY`/`HTTPS_PROXY` が設定済みのホストで、DevRelay には
プロキシを使わせたくない（または異なるプロキシを使わせたい）場合は、`.env` ではなく
NSSM のプロセス環境変数で上書きする（上記「プロキシ設定」節の理由により `.env` の空値は
Machine スコープの値に負ける）:

```powershell
nssm set devrelay-server AppEnvironmentExtra "HTTPS_PROXY= " "HTTP_PROXY= " "https_proxy= " "http_proxy= "
```

**値は空文字ではなく「空白 1 文字」にすること。** NSSM は `AppEnvironmentExtra` に空値
（`HTTPS_PROXY=`）を渡すとレジストリ（`REG_MULTI_SZ`）には書き込むが、環境ブロックを
組み立てる際に無視するため Machine スコープの値がそのまま残る（実機で確認。起動ログに
`🌐 プロキシ経由で外向き通信します: ...` が出続ける）。空白 1 文字なら NSSM が値として
保持し、`resolveProxyUrl()` 側の `candidate && candidate.trim() !== ''` 判定で除外されて
プロキシが無効になる。

停止は NSSM からの既定の停止要求（Ctrl+C 相当）で正常終了する。
`apps/server/src/index.ts` は `SIGINT` / `SIGTERM` に加え、Windows サービスが送る
`SIGBREAK` も捕捉して graceful shutdown する実装になっている。

`.env` の `DEVRELAY_SERVICE_RESTART_CMD` / `DEVRELAY_SERVICE_STATUS_CMD` を対応するコマンド
（`nssm restart devrelay-server` / `nssm status devrelay-server` 等）に設定し、WebUI の
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
$env:DEVRELAY_PROXY="http://proxy.corp.example:8080"  # 社内プロキシ経由が必要な場合のみ
irm https://<社内ドメイン>/install-agent.ps1 | iex
```

```bash
# Linux/macOS 端末
curl -fsSL https://<社内ドメイン>/install-agent.sh | bash -s -- --token "<トークン>" --proxy "http://proxy.corp.example:8080"
```

### DevRelay Server と同じホストに Agent を同居させる場合の注意

AI CLI（Claude Code 等）がホスト上の特定ユーザーのプロファイル配下にインストールされている
場合（例: `C:\Users\<ユーザー名>\.local\bin\claude.exe`）、Agent を別のサービスアカウント
（LocalSystem 等）で動かすと、その CLI が PATH に無く「AI ツール検出」が失敗する。
検出処理は Agent 起動時に 1 回だけ実行され `config.yaml` に永続化されるため、後から
気付きにくい。AI CLI をインストールした同じユーザーで Agent を動かす、または NSSM の
`AppEnvironmentExtra` で PATH にそのディレクトリを追加すること。

- [ ] 社内端末の Agent が接続でき、WebUI 上でオンラインと表示される

---

## 既知の制約（社内インスタンスでは使えない機能・運用ルール）

| 機能 | 理由 |
|---|---|
| Google OAuth ログイン | Google 側が公開 TLD の HTTPS リダイレクト URI を要求するため。ローカル email+password 認証（`/api/auth/register`）を使う |
| Claude.ai の MCP コネクタ | Anthropic クラウドからの inbound が必要なため。社内から PAT で `/mcp` を叩く用途は可 |
| Discord / Telegram | 未設定のため自動無効化（意図的） |
| testflight / DevRelay Sites | `DEVRELAY_TESTFLIGHT=0` / `DEVRELAY_SITES_HEALTH=0` / `DEVRELAY_SITES_ACCESS_LOG=0` で無効化 |
| LINE | DevRelay には実装が存在しない（CLAUDE.md の記述と異なる。`platforms/` は Discord/Telegram/Web のみ） |

**運用ルール: WebUI の設定画面から Discord/Telegram の Bot トークンを保存しないこと。**
`apps/server/src/index.ts` の `getBotTokenFromSettings()` は `userId` を問わず
`UserSettings` テーブルを全ユーザー横断検索し、**env 変数より DB の値を優先**する。
これには env によるキルスイッチが存在しないため、誰か 1 人が WebUI でトークンを保存すると
`DISCORD_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN` が未設定でも次回起動時に外部接続が始まる。

## テストに関する既知事項

`apps/server/tests/` のうち `sites-uu-secret.test.mjs` / `sites-access-reader.test.mjs` は
実ファイルシステムの file mode / inode を検証するため、Windows 上では失敗する場合がある
（本番稼働の testflight/sites 無効化構成には無関係）。
