# 社内オンプレ構築の事例と遭遇した問題（Windows / 既存稼働ホスト相乗り）

既に本番サービスが動いている Windows Server に DevRelay を**相乗り**で構築した実例の記録。
手順そのものは `doc/onprem-windows-setup-guide.md` にあり、本書はその補完として

- どの前提が崩れていたか
- 実際に踏んだ問題と、その症状・原因・対処

を残す。**エラーメッセージから引けるように症状ベースで並べてある**（§3）。

> 社内固有の値（ホスト名・IP・メールアドレス・既存アプリ名）は `example` 系に置き換えてある。

---

## 1. 導入先ホストの前提

「空きマシンに入れる」という前提が成り立たないケースだった。

| 項目 | 実態 |
|---|---|
| OS | Windows Server 2025（10.0.26100） |
| スペック | 4 vCPU / 16 GB RAM |
| 80 番 | **IIS が占有**。既存サイトが `/apps/...` 配下で本番配信中（約 1.6 万ファイル / 16 GB） |
| 前段 | 社内ロードバランサが TLS を終端し、HTTP で本ホストへ転送 |
| 実トラフィック | 多数の Android 端末が数秒おきに API をポーリング中 |
| 他プロセス | **pm2 で本番 Node アプリ 4 本**が稼働（:3001 / :3005 / :3100 / :5000） |
| Node | `v24.15.0` をグローバルに 1 つだけ。**上記 pm2 4 本が同じ Node で動いている** |
| PostgreSQL | 既存インスタンス（18.1）に 5 つの業務 DB が同居。pgvector 0.8.1 導入済み |
| プロキシ | Machine スコープに `HTTP_PROXY` / `HTTPS_PROXY` 設定済み。**社内アドレスへは到達できない外向き専用** |
| その他 | Defender リアルタイム保護 ON・除外ゼロ、EDR / 資産管理エージェント常駐 |

この前提から来る制約:

- **Caddy を 80/443 で起動できない**（既存配信が停止する）
- **グローバル Node を差し替えられない**（pm2 の本番 4 本を巻き込む）
- **pm2 に DevRelay を登録できない**（`pm2 save` が既存の `dump.pm2` を壊しうる。
  加えてそのホストの pm2 自動復帰は `HKCU\...\Run` 経由で**対話ログオン依存**だった）

幸い IIS に ARR / URL Rewrite が既導入だったため、Caddy を入れずに IIS をリバースプロキシに使えた。

---

## 2. 公開方式の選択

セットアップガイドのパターン A（Caddy 専用ホスト）/ B（新規ホストヘッダ + ARR）は、
どちらもこのホストでは選べなかった。

- A は 80/443 が埋まっているので不可
- B は新規ホストヘッダのために **DNS とロードバランサの設定追加が必要**で、
  ネットワーク担当への依頼が先行作業になる

そこで**既存サイトのサブパスに相乗り**する方式（ガイドのパターン C）を採った。

```
https://service.corp.example/apps/devrelay/
```

この方式の利点:

- DNS / ロードバランサ / TLS 証明書の追加作業が**一切不要**（既存サイトの HTTPS をそのまま使う）
- IIS サイトも仮想ディレクトリも作らない＝`applicationHost.config` を変更しないため、
  **既存アプリケーションの再起動が発生しない**

代償として WebUI のサブパス対応が必要だったが、`DEVRELAY_WEB_BASE` として実装・取り込み済み。

### 既存の Express 系アプリとの構成の違い

同ホストの既存アプリは Express が静的配信も担うため、`web.config` で**全リクエストを素通しで
Node に渡し、プレフィックスも剥がしていない**。

DevRelay の Fastify は静的配信を持たず（`@fastify/static` 非依存）、ルートが `/api/...` の
絶対パス固定なので、構成が逆になる:

- 静的ファイル（`apps/web` のビルド成果物）は **IIS が直接配信**
- API / WS / MCP だけ **プレフィックスを剥がして** Node に転送

フォルダ階層の `web.config` では `<match url>` がそのフォルダからの相対 URL にマッチするため、
`{R:0}` で転送すればプレフィックスは自然に落ちる。

---

## 3. 遭遇した問題（症状ベース）

### 3-1. `No projects matched the filters` が出るが、エラーにならず進む

**症状**: `pnpm install --filter @devrelay/web...` が何もインストールせずに成功扱いになり、
後続のビルドで初めて `node_modules` が空だと分かる。

**原因**: `apps/web` の `package.json` の `name` は **`web`** で、`@devrelay/web` ではない。

**対処**: `--filter web`。セットアップガイドの記述も修正済み。

また `@devrelay/server` のビルドは `@devrelay/shared` の `dist` を必要とするため、
同一コマンドにまとめず shared を先にビルドする。

---

### 3-2. `The "pnpm" field in package.json is no longer read by pnpm`

**症状**: pnpm 11 系の端末で上記警告が出て、続けて 2 つの形で壊れる。

```
[ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] Cannot proceed with the frozen installation.
       The current "overrides" configuration doesn't match the value found in the lockfile
```

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ..., @prisma/engines@..., ...
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

**原因**: pnpm 11 以降、`package.json` の `pnpm` フィールドが読まれない。結果として

1. `overrides` が無視されて `pnpm-lock.yaml` と不一致になり `--frozen-lockfile` が失敗
2. ビルドスクリプトの許可が無視され、**`@prisma/engines` の postinstall が走らず
   query engine バイナリが揃わない**。pnpm 11 では未判断のパッケージが残ると
   `ERR_PNPM_IGNORED_BUILDS` で install 自体が失敗する

→ **pnpm 11 の端末ではサーバー構築自体ができない状態だった。**

**さらに設定名が改名されている**（`pnpm approve-builds --all` が `pnpm-workspace.yaml` を
書き換える挙動から判明）:

```
pnpm 10 以前: onlyBuiltDependencies  （名前の配列）
pnpm 11 以降: allowBuilds            （名前 → true/false のマップ）
```

**対処**: `pnpm-workspace.yaml` に**両方の名前を併記**する（取り込み済み）。pnpm 11 は
「未判断」が 1 つでも残ると install を失敗させるので、ビルドさせたくないパッケージも
`false` で明示する必要がある。`.npmrc` に `onlyBuiltDependencies=[]` のような矛盾する
設定を残さないこと（空配列が勝つと prisma の postinstall が走らない）。

---

### 3-3. 設定を直したのに `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` が消えない

**症状**: 3-2 を修正して警告は消えたのに、**既に一度インストールした端末だけ**
`--frozen-lockfile` が落ち続ける。

**原因**: 修正前のフォールバック（非 frozen install）が **`pnpm-lock.yaml` から `overrides`
セクションを削除して書き戻していた**。その後に設定を復活させても、

- 取り込むコミット側が `pnpm-lock.yaml` を変更していなければ `git pull` は競合せず、
  ローカルの改変がそのまま残り続ける
- 結果「設定には `overrides` があるが lockfile には無い」状態が固定化する

**対処**: インストーラが `git pull` の前に `git checkout -- pnpm-lock.yaml` を実行して
毎回コミット済み状態へ戻すようにした（取り込み済み）。lockfile はリポジトリが唯一の情報源。

手動で直す場合: `git -C <agentDir> checkout -- pnpm-lock.yaml`

---

### 3-4. `Cannot find module '<repo>/apps/server/tests'`

**症状**: `pnpm test` がテスト 0 件で即座に失敗する（exit 1）。

**原因**: Node 22 でテストランナーのディレクトリ指定の扱いが変わり、`node --test tests/` が
ディレクトリを展開せずモジュールとして解決しようとする。

**対処**: `node --test "tests/**/*.test.mjs"`（全パッケージで修正済み）。
これにより 3 エージェントのテストが初めて実行可能になった。

---

### 3-5. HTTP 500.19（エラーコード `0x8007000d`）でフォルダ配下が全滅

**症状**: `web.config` を置いたフォルダ配下の全 URL が 500 になる。

**原因**: **XML コメント内にハイフン 2 連（`--`）があった**。XML はコメント内に `--` を
書けない。デプロイ手順をコメントとして残そうとして `pnpm --filter ...` と書いたのが原因。

**対処**: `pnpm -F` のような短縮形で書く。
検証は `[xml](Get-Content -Raw -Encoding UTF8 path)` で事前に行える。

---

### 3-6. `.webmanifest` が 404.3 になり PWA が壊れる

**原因**: IIS は未知の拡張子を配信しない。

**対処**: `web.config` に MIME 登録を追加する。親で既に定義済みの場合に重複エラーに
ならないよう `<remove>` を先に置く。

```xml
<staticContent>
  <remove fileExtension=".webmanifest" />
  <mimeMap fileExtension=".webmanifest" mimeType="application/manifest+json" />
</staticContent>
```

---

### 3-7. WebSocket が通らない（Agent が接続できない）

**原因**: IIS の WebSocket Protocol 機能（`IIS-WebSockets`）が無効だと、ARR は WebSocket を
中継できない。DevRelay の Agent / WebUI 接続は WebSocket なので中核機能が動かない。

**対処**:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebSockets
```

⚠️ これを実行すると **W3SVC / WAS が再起動し、同じ IIS 上の既存サイトが一瞬停止する**。
既存稼働ホストではメンテナンス枠を確保してから実行すること。

有効化後は `Get-WebGlobalModule` に `WebSocketModule` が現れる。

なお機械レベルの ARR タイムアウトは既定 `00:02:00` なので、長時間アイドルする WebSocket が
切断される可能性がある。

---

### 3-8. 発行したトークンが `wss://localhost:3000/ws/agent` になる

**症状**: Agent インストーラのトークン事前検証が中断する。

```
X エラー: サーバーに接続できません
  サーバー: https://localhost:3000
```

**原因**: トークンに埋め込む WS URL を**リクエストの `Host` ヘッダー**から組み立てていた。
IIS ARR は既定が `preserveHostHeader=false` のため、Fastify に届く `Host` は転送先の
`localhost:3000` に書き換わっている。サブパス配信ではプレフィックスも落ちる。

**対処**: `PUBLIC_URL` を唯一の情報源にした（取り込み済み・`services/agent-token-url.ts`）。

⚠️ **トークンは発行時の URL を固定で持つ。** `PUBLIC_URL` を直しても既存トークンは直らないので、
**作り直しが必要**。

---

### 3-9. プロキシを指定したのに Node が落ちてこない

**症状**: `DEVRELAY_PROXY` を指定したのに、Node 自動インストールのダウンロードが失敗する。
また端末モードが使えない（`conpty.node` が無い）。

**原因**: PowerShell 5.1 の `Invoke-WebRequest` / `Invoke-RestMethod` は
**`HTTP_PROXY` / `HTTPS_PROXY` 環境変数を見ず、システム（IE）のプロキシ設定を使う**。
インストーラが環境変数をセットしていても、それは git / npm / pnpm にしか効かず、
スクリプト自身のダウンロード（Node 本体・node-pty prebuilt）には一切効いていなかった。

**対処**: `-Proxy` を明示する共通ヘルパー経由に変更（取り込み済み）。

残る制約: **トークン事前検証はシステムプロキシを使う。** 社内ドメインのバイパスが
システムプロキシ側に無い端末では検証が失敗する。その場合は `$env:DEVRELAY_FORCE="true"` で
検証をスキップする（Agent 本体の接続は 3-10 の `noProxy` により直結するため動作する）。

Linux/macOS 版は curl を使っており、curl は `http_proxy` / `https_proxy` を自前で解釈するため
同じ問題はない。

---

### 3-10. プロキシを設定すると Agent が社内サーバーに接続できなくなる

**症状**: インストーラのプロキシ質問に `y` と答えると Agent が Server に繋がらない。
`N` と答えると `git clone` / `pnpm install` がプロキシを使えない。**どちらを選んでも壊れる。**

**原因**: `config.yaml` に `proxy.url` を書くと、Agent は **Server への WebSocket 接続にも
そのプロキシを使う**（`connection.ts` が `HttpsProxyAgent` を WS の agent に設定する）。
社内プロキシは社内アドレスへ到達できないのが通常。

実測:

```
社内プロキシ経由で社内サーバー : 到達不可
直結で社内サーバー            : 200
```

**対処**: `ProxyConfig.noProxy`（`NO_PROXY` 記法）を追加した（取り込み済み・
判定ロジックは `packages/shared/src/proxy-bypass.ts`）。

インストーラが**自動設定する**。プロキシ指定時に Server へ直結できるかをプローブし、
直結できる場合のみ Server のホストを `noProxy` に書く（直結できなければ従来どおり
全てプロキシ経由＝非退行）。

```yaml
proxy:
  url: "http://proxy.corp.example:8080"
  noProxy:
    - "service.corp.example"
```

これで **Server への WS は直結 / 外部 AI API はプロキシ経由**に分かれる。
`DEVRELAY_NO_PROXY` で明示指定も可能。

`noProxy` に対応していない古い Agent では、`config.yaml` の `proxy` ブロックを削除し、
プロキシを OS の環境変数で与えることで同じ状態にできる（Agent が起動する AI CLI は
親プロセスの環境を継承するため、外部 API には出られる）。

---

### 3-11. NSSM で `AppEnvironmentExtra HTTPS_PROXY=` が効かない

**症状**: プロキシを無効化したいのに、起動ログに
`🌐 プロキシ経由で外向き通信します: ...` が出続ける。

**原因**: NSSM は空値のエントリをレジストリ（`REG_MULTI_SZ`）には書き込むが、
環境ブロックを組み立てる際に無視するため、Machine スコープの値がそのまま残る。

**対処**: **値を空文字ではなく「空白 1 文字」にする**。NSSM が値として保持し、
`resolveProxyUrl()` 側の `candidate && candidate.trim() !== ''` 判定で除外される。

```powershell
nssm set devrelay-server AppEnvironmentExtra "HTTPS_PROXY= " "HTTP_PROXY= " "https_proxy= " "http_proxy= "
```

---

### 3-12. WebUI の「サービス再起動」でサービスが停止したまま戻らない

**症状**: API は `{"success":true,"message":"Server restart initiated"}` を返すのに、
その後サービスの PID が 0 のままになり、IIS は 502 を返すようになる。
`server.err.log` に実行コマンドと `stderr: '^C'` が残る。

**原因**: 再起動 API は Server プロセス自身から `exec` でコマンドを起動する。
`nssm restart` を直接指定すると、nssm が停止のために送る Ctrl+C が同じコンソールグループ
全体に飛び、**停止を実行している nssm.exe 自身も巻き込まれて死ぬ**。start が発行されない。

**対処**: 新しいコンソールへ切り離し、呼び出し元の終了を待ってから起動する `.cmd` を経由する。

```bat
@echo off
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Restart-Service devrelay-server"
```

```env
DEVRELAY_SERVICE_RESTART_CMD=C:\tools\devrelay-restart.cmd
DEVRELAY_SERVICE_STATUS_CMD=C:\tools\nssm.exe status devrelay-server
```

確認は「ボタンが動くこと」ではなく **「サービスの PID が変わって `Running` に戻ること」**で行う
（PID が 0 のままなら上記の自殺パターンに陥っている）。

---

### 3-13. `DEVRELAY_WEB_BASE` が Git Bash で壊れる

**症状**: `DEVRELAY_WEB_BASE=/apps/devrelay` を指定したのに、ビルド結果の URL が
`/C:/Program Files/Git/apps/devrelay/...` になる。

**原因**: Git Bash（MSYS）が `/` 始まりの値を Windows パスに変換する。

**対処**: PowerShell で設定するか、先頭スラッシュ無しで渡す（`vite.config.ts` 側で
前後スラッシュを正規化しているため `apps/devrelay` でも動く）。

---

## 4. 稼働中の環境を壊さずに検証する作法

既存本番が動いているホストでの作業なので、検証方法自体に気を使った。これは再現性のためにも有効だった。

### 一時クローンで pnpm を検証する

`pnpm install` は `node_modules` の構造を作り直すことがあり、稼働中のサービスを巻き込みうる。
また pnpm のバージョンを切り替えると `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` で止まる。

→ **同一コミットの一時クローンを作ってそこで検証する**。`git clone --no-hardlinks <local-repo>` で
数秒で用意できる。pnpm のバージョン別検証は `npx pnpm@11.4.0` 等で切り替え、
非対話環境では `CI=true` を付ける。

⚠️ ローカルクローン時も `--config core.autocrlf=false` を忘れないこと
（system スコープで `core.autocrlf=true` が設定されていると CRLF になり、
厳密一致のパッチ処理が全部外れる）。

### `git stash` でテストのベースラインを取る

Windows 上で Linux/macOS 版エージェントのテストを走らせるとパス区切りや POSIX スクリプト起動の
都合で多数失敗する。**自分の変更が原因かを判定するには、変更を `stash` して同条件で
失敗数を取り直すのが確実**。

今回は macOS 版の失敗数が揺れたため、ベースラインを 2 回取って安定を確認したうえで
変更後と比較し、差分が**スイート並列実行時のみ落ちる既存のフレーキー**（単体実行では
7/7 パス）であることを突き止めた。

### 既存本番の無事を毎回確認する

作業の前後で相乗り先の URL を叩き、`pm2 list` の uptime が途切れていないことを確認した。
最終的に **既存 4 本の uptime は一度も途切れていない**。

---

## 5. チェックリスト（既存稼働ホストに相乗りする場合）

公開方式を決める前に:

- [ ] 80 / 443 を誰が握っているか（`netstat -ano` と IIS のサイト一覧）
- [ ] その配信が本番トラフィックを持っているか（アクセスログを実際に見る）
- [ ] 既存の pm2 / サービスが何を動かしているか（`pm2 list`）
- [ ] その pm2 の自動復帰方法（Run キー / スケジュールタスク / サービス）
- [ ] グローバル Node を共用しているプロセスがあるか
- [ ] PostgreSQL が既存インスタンスか、DB 名が衝突しないか、`CREATE EXTENSION vector` の権限
- [ ] プロキシ env のスコープ（Machine / User）と、**プロキシが社内アドレスへ到達できるか**
- [ ] `IIS-WebSockets` が有効か（無効なら W3SVC 再起動のメンテ枠が必要）
- [ ] `core.autocrlf` の設定値
- [ ] ウイルス対策 / EDR の除外設定

構築後の確認:

- [ ] `/<サブパス>/health` が `{"status":"ok"}`
- [ ] `/<サブパス>/manifest.webmanifest` が `application/manifest+json` で 200
- [ ] `/<サブパス>/chat` 等の SPA ルートが 200（`index.html` フォールバック）
- [ ] `wss://<host>/<サブパス>/ws/web` が `101 Switching Protocols`
- [ ] WebUI のサービス再起動で **PID が変わって `Running` に戻る**
- [ ] 発行したトークンの埋め込み URL が正しい（`drl_` の後ろを base64url デコードして確認）
- [ ] 起動ログに `SETTINGS_ENCRYPTION_KEY` 未設定警告が出ていない
- [ ] 起動ログのキルスイッチ（Sites / testflight / Discord / Telegram）が意図どおり
- [ ] **相乗り先の既存サービスが引き続き正常応答している**
- [ ] **既存 pm2 プロセスの uptime が途切れていない**

---

## 6. 検証済みの組み合わせ

```
Windows Server 2025 (10.0.26100)
Node 24.15.0 / 24.16.0        — Prisma 5.22.0 と組み合わせて問題なし
pnpm 10.33.2 / 11.4.0 / 11.28.5
PostgreSQL 18.1 + pgvector 0.8.1 — prisma db push / db:bootstrap とも成功
IIS 10.0 + ARR 3.0 + URL Rewrite + WebSockets
NSSM 2.24
```

Node 24 と PostgreSQL 18 はどちらも Prisma 5.22 の想定より新しいが、
`prisma generate` / `db push` / `db:bootstrap` / `tsc` のいずれも問題なかった。
Node を側置きする必要はなかった。
