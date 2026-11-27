<!-- DevRelay Agreement v6 -->
See `rules/devrelay.md` for DevRelay rules.
<!-- /DevRelay Agreement -->

---

# DevRelay

Discord/Telegram/LINE から Claude Code/Gemini CLI/Devin CLI をリモート操作するハブシステム。

## ルール参照
- `rules/devrelay.md` - DevRelay 共通ルール（Agreement）
- `rules/project.md` - プロジェクト固有の設計判断

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| Monorepo | pnpm workspaces |
| Server | Fastify + WebSocket + Prisma |
| DB | PostgreSQL |
| Agent | Node.js CLI (Linux + Windows) |
| WebUI | Vite + React |
| Proxy | Caddy |
| Process | PM2 |

## ビルド & デプロイ

```bash
pnpm build
# 再起動はユーザーが実行（会話が終わるまで自動で待つ。Linux/Windows 共通コマンド）:
pnpm --filter @devrelay/server restart:when-idle
# 状況だけ見る: --status を付ける。待たずに今すぐ再起動: --force を付ける
```

再起動耐性サイクル（2026-11-25）により、`pm2 restart devrelay-server` を直接打っても
（会話中ガードは効かないが）予告配信・graceful shutdown・Agent 側の送信キューで応答消失は
防げる。設定変更（`kill_timeout` 等）は不要（pm2/NSSM どちらの既定値でも収まるよう
サーバー側の停止処理を予算化してある）。詳細 `doc/devlog/2026-11-25_restart_resilience.md`。

> **Agent を pm2 に登録しないこと。** この機体の Agent は crontab `@reboot` による nohup 起動が正
> （`~/.devrelay/agent/agents/linux/dist/index.js`）。pm2 に `devrelay-agent` を登録すると同一 machineId で
> 二重起動し、サーバーが新接続のたびに旧 WebSocket を切断するため無限再接続ループになり、
> **AI の応答がユーザーに届かなくなる**。詳細は `doc/agent_noresponse_20260814.md`。
>
> 二重起動の確認（node プロセスが 2 つ以上なら重複）:
> ```bash
> pgrep -u $(whoami) -af "\.devrelay.*index\.js" | grep -v "bash -c"
> ```

## DevRelay 自身の開発時の注意
- ビルド（pnpm build）は実行OK
- サービスの再起動は実行しない
- **ソースコード（.ts ファイル等）を変更して `pnpm build` を実際に実行した場合のみ**「ビルド完了。以下のコマンドで再起動してください」と案内する
- ドキュメント（.md）のみの変更ではビルド・再起動案内は不要

## DB スキーマ変更時の必須手順（サイクルM1、2026-11-12）

`prisma migrate dev` / `migrate deploy` / `db push` は使わない（`db push` は pgvector の
`embedding` 列を DROP するため永久禁止。`apps/server/prisma/bootstrap.sql` 冒頭の警告参照）。

1. `schema.prisma` を変更
2. `apps/server/db/changes/NNNN_xxx.sql` を新規作成し、`INDEX.tsv` に 1 行・`SCHEMA.sha256` を
   更新する（**この4点を同じコミットに入れる**。テンプレートは `apps/server/db/changes/README.md`、
   詳細手順は `doc/db-changes.md` 参照）
3. `npx prisma generate` で Prisma Client 再生成
4. `pnpm build` でビルド（`node --test tests/db-changes.test.mjs` が green であることを確認）
5. **DB への適用は人間が `psql` で行う**（アプリと同じロール、postgres 等の superuser では流さない）。
   適用後は `information_schema.columns` でカラム存在を検証する
6. 再起動案内時に「DB マイグレーション適用済み」を明記する

> **会社リポジトリ（TISA）独自の DB 変更は本家の連番を使わない。** 手順 2 の代わりに
> `apps/server/db/changes/tisa/TISA<4桁>_xxx.sql` を作り `tisa/INDEX.tsv` に 1 行足す。
> `SCHEMA.sha256` は 1 列目（指紋）だけ更新し、2 列目は本家の最大番号のファイル名のまま。
> テストは `tests/db-changes-tisa.test.mjs`。詳細は `doc/db-changes-tisa.md`。

## ポート割り当て規約（90xx 番台）

`/etc/caddy/sites.d` 配下のサイトが使う 9000 番台ポートは、手動作成と `testflight` 自動作成が混在するため、衝突を避けるためレンジを分離している（2026-10-18 `testflight` が手動作成サイトと同じポート 9027 を払い出した衝突事故の根治）。

| レンジ | 用途 |
|---|---|
| 9001-9299 | 手動作成プロジェクト・`testflight` 旧採番の既存サービス（現在 9001-9029 使用中） |
| 9300-9499 | `testflight` の自動採番専用（`DEVRELAY_TESTFLIGHT_PORT_START` で開始位置変更可、既定 9300） |

**新規に手動で Caddy サイトを作る場合は 9001-9299 側からポートを選ぶこと。** `testflight` コマンドは常に 9300-9499 からのみ採番するため、この規約を守れば両者は交わらない。

## 環境変数（apps/server/.env）

> ⚠️ **2026-11-08 判明**: `apps/server/dist/index.js` の `import 'dotenv/config'` はパス指定なしなので
> `process.cwd()` 基準で `.env` を探す。pm2 の `devrelay-server` は `exec cwd=/opt/devrelay`
> （リポジトリルート）で起動するため、**実際に読まれるのは `/opt/devrelay/.env`**（`apps/server/.env`
> へのシンボリックリンク）。`apps/server/.env` 自体は編集しても symlink 経由でしか本番に反映されない。
> 新しいキーを追記したら `pm2 restart devrelay-server`（`--update-env` は使わない。現在のシェルの
> env で丸ごと置き換わり既存キーが消える危険があるため）。

| 変数 | 説明 |
|------|------|
| DATABASE_URL | PostgreSQL 接続 |
| DISCORD_BOT_TOKEN | Discord Bot |
| TELEGRAM_BOT_TOKEN | Telegram Bot |
| SETTINGS_ENCRYPTION_KEY | UserSettings（API キー・Bot トークン）暗号化用の鍵（旧記載の `ENCRYPTION_KEY` は誤記）。未設定時はリポジトリ内の公開デフォルト値にフォールバックし起動時に警告。⚠️ 稼働中の環境に後から設定/変更すると既存の暗号化済み設定が復号不能になるため、新規構築時に一度だけ設定すること |
| FIREBASE_SERVICE_ACCOUNT_PATH | FCM プッシュ通知用サービスアカウント JSON |
| HTTPS_PROXY / HTTP_PROXY / NO_PROXY | 社内プロキシ経由でのみ外部 HTTPS（AI API 等）に出られる環境向け。設定すると undici の globalDispatcher に ProxyAgent を登録する（`services/proxy-dispatcher.ts`）。未設定なら何もしない（既定 VPS 環境は無変更） |
| DEVRELAY_SERVICE_RESTART_CMD / DEVRELAY_SERVICE_STATUS_CMD | `POST /api/services/restart/server` / `GET /api/services/status` が実行するコマンド（既定は `pm2 restart devrelay-server` / `pm2 pid devrelay-server`）。Windows 等 pm2 を使わない環境で上書きする |
| DEVRELAY_PLAN_STRICT_CHAT | チャット経路のプランターンを strictReadonly にするか（既定 `1`。`0` で従来の `interactive` に戻すキルスイッチ。chat のみに作用し mcp/exec には影響しない） |
| DEVRELAY_THREADS_HIDE_EMPTY_ENDED | `GET /api/threads` で ended かつ Message 0件の抜け殻スレッドを一覧から隠すか（既定 `1`。`0` で従来どおり全件表示するキルスイッチ） |
| DEVRELAY_SITES_HEALTH | DevRelay Sites（`/sites`、管理者限定）の公開サイトヘルスチェック定期実行を有効にするか（既定 `1`。`0` で無効化するキルスイッチ。`/api/sites` 自体は無効時も 200 を返し health は unknown になる） |
| DEVRELAY_SITES_ACCESS_LOG | DevRelay Sites のアクセスログ集計（PV/UU/Referer/UTM）定期実行を有効にするか（既定 `1`。`0` で無効化するキルスイッチ。stats は null に縮退） |
| DEVRELAY_TESTFLIGHT | testflight コマンド（`sudo`/`pm2`/`systemctl reload caddy`/`/etc/caddy/sites.d` 前提）を有効にするか（既定 `1`。`0` で無効化するキルスイッチ。社内オンプレ等 Linux+sudo+Caddy が無い環境では `0` を推奨） |
| DEVRELAY_TESTFLIGHT_PORT_START | testflight 自動採番レンジの開始ポート（既定 `9300`、clamp 9001〜9900）。2026-10-18 の 9027 衝突事故後、新規採番は 9001-9299（手動プロジェクト・旧採番サービス用）と重ならない 9300-9499 に分離した。上限は 9499 固定 |
| DEVRELAY_MCP_ASK | MCP の `ask_project` / `get_answer` ツールを登録するか（既定 `1`。`0` で登録自体をやめるキルスイッチ。`cancel_submission` と既存 8 ツールには影響しない） |
| DEVRELAY_MCP_ANSWER_RAW | MCP `get_answer.answer` / `get_plan.planMarkdown`・`summary` から進捗表示行（📊 Rate Limit / 🔧 …を使用中... 等）を除去するかの逆キルスイッチ（既定 `0` = 除去する。`1` で従来どおり原文を返す）。`get_build_status.tail` 等の進捗確認用フィールドには影響しない |
| DEVRELAY_PROGRESS_CANCEL_HINT | Discord/Telegram の進捗ボックス（実行中... N分経過）に「`k` で停止できます」の案内行（60秒経過後）を出すか（既定 `1`。`0` で無効化するキルスイッチ。WebUI は進捗表示に停止ボタンがあるため対象外） |
| DEVRELAY_KNOWLEDGE | 会話ターンのナレッジ化（`KnowledgeChunk` への embedding 生成）と MCP `search_knowledge` / REST `GET /api/knowledge/search` を有効にするか（既定 `1`。`0` で MCP ツール未登録・REST 404・新規会話での行作成も停止するキルスイッチ。バックフィル CLI（`knowledge:backfill`）はこの変数を見ない＝明示実行は常時可。サイクル2 の `get_knowledge_thread` / `set_thread_classification` / `routes/knowledge-admin-api.ts` も同じキルスイッチを共用） |
| DEVRELAY_EMBEDDING_API_KEY | 高辻ナレッジ サイクル2: embedding 生成・検索に使う組織共通の OpenAI API キー。個人キー（UserSettings）が未設定のユーザーのフォールバック先（優先順位: 個人キー → 本変数）。未設定時は個人キーのみで従来どおり動作（個人キーも無ければ `skipped`）。値はログに出さない |
| DEVRELAY_KNOWLEDGE_ANSWER | 高辻ナレッジ サイクル4: ナレッジ検索（`/knowledge`）にAI回答（RAG）パネルを足すか（既定 `1`。`0` で `POST /api/knowledge/answer` が 404・WebUI の「AI 回答」トグル非表示。`DEVRELAY_KNOWLEDGE` とは独立＝これが `0` でも検索自体は従来どおり使える。サイクル4.5: MCP `ask_knowledge`（`search_knowledge` の直後に登録。`DEVRELAY_KNOWLEDGE` と本変数の両方が ON のときのみ登録）も同じキルスイッチ・同じ流量制御（`services/knowledge-answer-slot.ts`）を共用） |
| DEVRELAY_ANSWER_API_KEY | 高辻ナレッジ サイクル4: ナレッジ回答の生成に使う**組織共通・専用**の OpenAI API キー。個人の Chat AI キーにも汎用 `OPENAI_API_KEY` にもフォールバックしない（用途別に費用を分けるため、ユーザー承認の最終決定）。未設定時は回答欄に鍵未設定の 1 行が出るのみで、検索（カード）は従来どおり動く。値はログに出さない |
| DEVRELAY_ANSWER_MODEL | 高辻ナレッジ サイクル4: ナレッジ回答に使う OpenAI モデル名（既定 `gpt-4o-mini`）。provider は常に OpenAI 固定。ポータル P1 のニュース要約（`portal:news`）も `DEVRELAY_ANSWER_API_KEY` と本変数を流用する（ユーザー決定 2026-11-21） |
| DEVRELAY_UPDATE_BUSY_GUARD | サイクル3.1: 実行中 AI ターン中の Agent 自己更新保留（`isMachineBusy()` の実行中ターン台帳 + 手動 `u`/`server:agent:restart` の busy ガード）を有効にするか（既定 `1`。`0` で従来挙動に戻すキルスイッチ。Agent 側の D2（`sendPromptToAi()` 実行中は `server:agent:update` を保留する最後の砦）にはキルスイッチを置かず常時有効） |
| DEVRELAY_WEB_COMMAND_PERSIST | WebUI のコマンド入力/応答（`testflight`・`status`・`log` 等の非 AI ターン）を `Message` に保存するか（既定 `1`。`0` で従来どおり WS 配信のみ＝再接続・リロード・スレッド切替で消えるキルスイッチ。AI ターン系（`exec`/`agreement`/`ai:prompt`/`ask:member`/`teamexec:member`）は元々自前で保存しているため対象外、`login*`/`clear`/`quit` も対象外） |
| DEVRELAY_BOT_SUPERVISOR | 2026-10-18 起動ハング対策A: Discord/Telegram bot 起動の監督ループ（`services/bot-supervisor.ts`）が無制限リトライするか（既定 `1`。`0` で「1 回だけ試行して諦める」に縮退するキルスイッチ。`app.listen()` を bot 起動より先に行う起動順序自体にはキルスイッチを置かない＝無効化は障害の再導入のため。詳細 `doc/server_listen_hang_20261018.md`） |
| DEVRELAY_BOT_LOGIN_TIMEOUT_MS | bot 起動 1 回分の試行タイムアウト（既定 `30000`、clamp 5000〜300000） |
| DEVRELAY_BOT_RETRY_MAX_MS | bot 起動リトライ間隔の上限（既定 `300000`、clamp 10000〜3600000） |
| DEVRELAY_CONVERSATION_RAIL | 右レール第3タブ「会話履歴」（直近20スレッド横断・実行中スピナー・未確認緑✓）向けに `GET /api/threads` が `running`/`lastAiAt` フィールドを返すか（既定 `1`。`0` で両フィールドを一切出さない＝旧レスポンスと構造的に同一になるキルスイッチ。DB 変更なし・既読状態はブラウザの localStorage 管理） |
| DEVRELAY_PUSH_DIAG | 2026-10-22 の FCM 無音故障（アプリ再インストール後、配信先の無いトークンへ送信し続けエラーも出ないまま無音で壊れた）の再発防止として追加した診断ログ（配信先 0 件の警告・送信結果1行ログ）を出すか（既定 `1`。`0` で従来どおり無言。`fcm-service.ts`） |
| DEVRELAY_FCM_STRICT_DELETE | FCM トークン削除ポリシーを `invalid-argument` も削除対象にする旧挙動に戻すキルスイッチ（既定 `0` ＝安全側）。2026-11-02 の iPhone SE3 無音故障（唯一のトークンが `invalid-argument` 5連続失敗で誤って自動削除された）を受けて、既定では `invalid-argument` は連続失敗回数に関わらず一切削除しない（旧: 5回で削除）。`1` にすると即削除の対象になるが、それでも「削除すると配信先が0件になる場合は削除しない」ゼロ件ガードは常に先に適用される（端末1台しか無いユーザーでは `1` でも削除されない） |
| DEVRELAY_FCM_TEST_API | 設定画面の「テスト通知を送る」が使う `POST /api/push/fcm/test` を有効にするか（既定 `1`。`0` で 404。`GET /api/push/fcm/devices`・`POST /api/push/fcm/verify`・`DELETE /api/push/fcm/devices/:tokenPrefix` には影響しない） |
| DEVRELAY_THREAD_HANDOVER | スレッド引継ぎ `n`（next thread）を有効にするか（既定 `1`。`0` で `n make` / `n` / `n 1` を従来どおり AI へのプロンプトとして扱うキルスイッチ）。元スレッドで `n make` を送るとその AI が引継ぎ書を書いて `<projectPath>/doc/handover/` に保存し、新スレッドで `n` で作成済み引継ぎ書を一覧、`n 1` で選んで今のスレッドに注入する。詳細 `doc/thread-management-spec.md` §11 |
| DEVRELAY_THREAD_AUTO_TITLE | スレッドタイトル自動命名（2026-11-21、DB 変更 0033）を有効にするか（既定 `1`。`0` で生成停止・`GET /api/threads` が `autoTitle`/`handoverFromTitle` を返さない＝従来表示）。AI 応答 1・3・8 回目に `DEVRELAY_ANSWER_API_KEY`（同じ組織共通キー・`DEVRELAY_ANSWER_MODEL`）で短い題名を作り `Session.autoTitle` に保存する（ユーザー命名の `title` には書かない・`title` があるスレッドは生成しない）。鍵未設定なら AI 命名だけ行わず、`n`/`n 1` 等のコマンド発言を題名にしない・引継ぎスレッドに「↪ 元の題名」を出す改善は効く。詳細 `doc/devlog/2026-11-21_thread_auto_title.md` |
| DEVRELAY_USAGE | Usage（コスト集計）画面 `/usage` とその API（`/api/usage*`）、ログイン不要のサイネージ `/signage/usage?token=…`（`GET /api/public/usage-signage`）を有効にするか（既定 `1`。`0` で全 API が 404 になるキルスイッチ）。金額は会話履歴のコスト列と同じ `resolveMessageCost()`、月は日本時間の暦月。閲覧は組織全員、グループ（人のタグ）は本人と管理者、案件（スレッドのタグ）はスレッドの持ち主と管理者が変更でき、サイネージ URL の発行・停止は管理者のみ。詳細 `doc/devlog/2026-11-19_usage_cost_aggregation.md` |
| DEVRELAY_USAGE_CASE_REQUIRED | WebUI（チャット・Lite）で案件（`Session.usageCase`）が空のスレッドには AI プロンプトを送らせないか（既定 `0`＝送れる。`1` のときだけ必須。コマンド（`e`/`x`/`h`/`n make`/`u`/数字選択 等、`isTraditionalCommand()`）と `//` 内部コマンドは止めない。Discord/Telegram/MCP は対象外）。入力欄の上の「🏷 案件」欄で設定する。詳細 `doc/devlog/2026-11-19_usage_case_in_chat.md` |
| DEVRELAY_PORTAL | ポータル P1（会社リポジトリのみ）: `/api/portal/*`（資料 PDF・ニュース・全体課題・自分の TODO）を有効にするか（既定 `1`。`0` で全 404＝ポータル画面は資料・ニュース・課題が空欄になるだけで表示は続く）。詳細 `doc/devlog/2026-11-21_portal_p1.md` |
| DEVRELAY_PORTAL_DIR | ポータル P1: 資料・ニュース・全体課題の置き場所（会社サーバーは `D:\portal`）。配下の **PDF のみ** をログイン不要で一覧・配信する（直下フォルダ = 分類、直下ファイル = 方針。`news/`・先頭 `.`/`_` は除外）。`news/items.json` がニュース、`issues.json` が全体課題。未設定なら API は空を返す。ニュースは CLI `portal:news`（`C:\tools\portal-news.cmd` を毎日）がコミット歴を `news/commits/` に書き出し、`DEVRELAY_ANSWER_API_KEY` で要約して追記する |
| DEVRELAY_BACKLOG | Backlog 連携（2026-11-21）を有効にするか（既定 `1`。`0` で `/api/backlog/*`・`/api/agent/backlog/*` が 404、AI への【Backlog課題】1 行も付けない）。設定は人ごとの「接続」（スペース URL・個人の API キー・使うプロジェクト・段階→状態の対応）を何件でも持てる（UserSettings `backlog_connections`、JSON 全体を暗号化。旧形式 `backlog_space`/`backlog_api_key`/`backlog_projects` は接続 1 件として読み替え、次の保存で移行）。課題キーのプロジェクトキーから接続を自動で決める。スキル `devrelay-backlog` はプランモードでも使える。詳細 `doc/devlog/2026-11-21_backlog.md` |
| DEVRELAY_BACKLOG_SPACE | Backlog 連携: 組織既定のスペース（例: `https://xxx.backlog.com` やホスト名のみ。パスは無視）。設定画面で接続を追加するときの初期値と、旧形式 1 件の読み替えにだけ使う（devrelay.io のように各自が自分のスペースを入れる環境では未設定でよい）。`*.backlog.jp` / `*.backlog.com` / `*.backlogtool.com` 以外は無視（API キーを任意のホストへ送らないため） |
| DEVRELAY_AGENT_REPO_URL | 会社 private リポジトリ clone 対応サイクル: `GET /api/machines/:id/token` が WebUI に返す、Agent インストール一行コマンドに付与する clone 先 URL（`https://` 必須・userinfo 付き URL は拒否して無視）。**未設定時は WebUI のコマンドが現行と完全に同じ文字列になる**（実質的なキルスイッチ）。PAT は**本変数には**一切乗せられない（userinfo 付き URL は拒否）。PAT の配布方式は下記 `DEVRELAY_AGENT_REPO_TOKEN` 参照。詳細 `doc/company-repo-sync.md` |
| DEVRELAY_AGENT_REPO_TOKEN | 読取PATのサーバー配布サイクル: 上記 `DEVRELAY_AGENT_REPO_URL` とセットのときのみ有効な読取 PAT。DB には一切保存しない（env のみ）。`POST /api/agent/repo-auth`（HTTP、インストール時）・WS `agent:repo:auth:request`（`u` 実行前のローテーション）のどちらも**マシントークンで認証済みの Agent にのみ**配布する（値は `Authorization: Basic <base64>` 形式でのみ渡し、WebUI・ログ・DB には一切出さない）。未設定時は Agent 側で一切の新規通信が発生しない（既存の個人 devrelay.io 含む全環境は無変更）。前サイクルの「PAT をサーバーに送らない」方針を本サイクルで**サーバー env に限り**見直した判断（`Machine.token` 平文保存 ⇒ DB 侵害時のリスクを明示的に受容。前提は Fine-grained・対象リポジトリのみ・`Contents: Read-only`・有効期限必須）。詳細・優先順位・ローテーション手順は `doc/company-repo-sync.md` §9 |
| DEVRELAY_CROSS_TEAM | 別ユーザーのエージェントとチームを組む機能（クロスユーザー ask・招待 API・WebUI 招待 UI）を有効にするか。**既定 `0` = OFF**（既存キルスイッチの多数派と逆方向。新しい信頼境界を黙って開けないため）。`1` で有効化。OFF 時は authz がクロス判定に入らず従来の 404・新設 API（`/api/teams/org-candidates`・`/api/teams/invites` 等）は全て 404・`GET /api/teams`/`GET /api/agent/members` の応答は旧構造と完全同一（新フィールドはキーごと省略）。対象は同一 Organization 内のみ（組織未所属ユーザー同士は不可）。teamexec（exec）は本変数だけでは動かない（下記 `DEVRELAY_CROSS_TEAM_EXEC` 参照、Phase 1 では構造的に到達不可） |
| DEVRELAY_CROSS_TEAM_EXEC | クロスユーザー `teamexec`（他ユーザーのプロジェクトでの exec = コード改変）を有効にするか。既定 `0`。`DEVRELAY_CROSS_TEAM=1` かつ本変数 `1` かつ受入側が `CrossTeamGrant.execAllowed=true` にしている、の 3 条件 AND でのみ通る設計（Phase 1 時点では受入側 UI に exec 許可トグル自体が無く execAllowed は常に false のため、本変数を `1` にしても何も変わらない。Phase 2 で解禁予定） |
| DEVRELAY_CROSS_TEAM_PUBLISH | 公開型クロスユーザー Team（Phase A: サーバー + 認可のみ、2026-11-08。WebUI は Phase B 未実装）を有効にするか。既定 `0` = OFF。`DEVRELAY_CROSS_TEAM=1` と本変数 `1` の両方が揃って初めて新設 6 ルート（`PATCH /api/teams/:teamId/visibility`・`GET /api/teams/published`・`POST/DELETE /api/teams/:teamId/subscribe`・`GET /api/teams/:teamId/subscribers`・`DELETE /api/teams/:teamId/subscribers/:userId`）が有効になる（どちらか OFF なら全て 404）。認可本体 `decideCrossTeamAccess()` は無改造 — `TeamSubscription`（購読）から `cross-team-publish.ts` がその場で候補を合成して渡すだけ。公開対象は招待型で受け入れた他人のプロジェクトを除外し、チームオーナー自身が所有するプロジェクトに限定する（又貸し防止） |
| DEVRELAY_CROSS_TEAM_CHAT | クロスユーザー Team Phase C（2026-11-10）: 購読/借用プロジェクトを WebUI の Agents ツリーに出し、質問専用タブとして直接 ask できるようにする機能を有効にするか。既定 `1`（`DEVRELAY_CROSS_TEAM=1` との AND でのみ実際に有効＝既定 OFF 環境では何も起きない）。`0` で新設 2 ルート（`GET /api/cross-team/ask-targets`・`GET /api/cross-team/projects/:id/messages`）が 404、WS `web:cross:ask` は `web:error` を返し**いかなる DB 書き込みもしない**、ツリーのセクションも非表示になる。認可は既存 `listCrossTeamAskCandidateProjects()` を再利用するだけで新しい認可クエリは持たない。送信は `web:command`（`parseCommandWithNLP`/`executeCommand`/`handleProjectConnect`）を一切通らない専用 WS フレームのため、クロスタブでは `e`/`k`/`a`/`testflight`/`//connect` 等が文字列として宛先に渡るだけで構造的に exec へ到達できない。本機能の前提として、チャット（WS）経路のみに存在していた既存の権限昇格の穴（`handleProjectConnect`/`handleMachineConnect`/`handleProjectList` が所有者チェックをしていなかった）を同サイクルで修正済み（キルスイッチの外、常時有効） |
| DEVRELAY_CROSS_TEAM_CHAT_CONTEXT | 上記 Phase C の会話継続（案 B）: クロス ask のプロンプト先頭に、同一依頼者×プロジェクトの直近 3 往復（最大 6,000 文字、truncate 済み）を「これまでのやりとり（参考）」として前置するか。既定 `1`。`0` で前置をやめ、完全な 1 問 1 答に戻す（履歴 API の表示には影響しない）。Agent 側の改修は無し（セッションは従来どおり `crossquery_<uuid>` の使い捨てのまま。安定セッション再利用による本物の resume はセルフレビューで撤回——`.devrelay-output/` 全消し事故の再発リスクがあったため——別サイクルで capability ゲート付きの案 C′ として再検討） |
| DEVRELAY_CHAT_CTX_PER_USER | Discord/Telegram の共有チャンネルで、同じ chatId に複数ユーザーが発言したときキャッシュ済み `UserContext` の `userId` を発言者ごとに再解決するか（既定 `1`。`0` で「そのチャンネルで最初に話した人の userId に全員の操作が固定される」旧挙動に戻すキルスイッチ。2026-11-05 に発見・修正、詳細は `doc/changelog.md` のクロスユーザー Team サイクル参照） |
| DEVRELAY_CROSS_ASK_ISOLATION | サイクルG（2026-11-10）: クロスユーザー ask（別ユーザーのプロジェクトへの質問）で所有者プロジェクトの状態を隔離するか。既定 `1`。`1` のとき、Session 作成前に (a) 宛先 Agent が `'cross-ask-isolation'` capability を申告しているか、(b) 読み取り専用を権限で強制できる実効 AI か（devin/gemini/claude+`Project.terminalMode` は不可）を検証し、どちらか NG なら ask 自体を断る（`denied`、監査記録あり）。許可されれば Agent へ `statePolicy:'isolated'` を送り、所有者の storageContext 注入・`.devrelay-output/` 添付・Codex/Devin セッション resume を一切行わせない。`0` で検証自体を行わず旧挙動（`statePolicy` を送らない）に戻すキルスイッチ。同一ユーザーの ask（スキル／MCP／`ask` コマンド）には一切影響しない。Agent 側の他の既存バグ修正（Codex/Devin 状態の書き込み禁止・approve-all 状態の遮断・`/tmp` プロンプトファイルの権限・クリーンアップ）は一時セッション全般に無条件で効くため本変数の対象外（ロールバックは `git revert` + 該当機 `u`） |
| DEVRELAY_CROSS_ASK_RESUME | サイクルC2（2026-11-11）: クロスユーザー ask のセッション継続（resume）を有効にするか。既定 **`0`（OFF）**（`DEVRELAY_CROSS_TEAM` 等と同じ方向。`DEVRELAY_CROSS_ASK_ISOLATION` の既定 ON とは逆）。`1` のとき、G の隔離判定を通過した ask のうち、宛先 Agent が `'cross-ask-resume-strict'` capability を申告し、かつ読み取り専用を権限で強制できる実効 AI（`decideAskReadOnlyEnforcement()`、devin/gemini/claude+terminalMode は不可）に限り、`statePolicy:'isolated'` の代わりに `statePolicy:'resumable-scoped'` と決定論的な `agentScopeId`（`crossask-<digest32>-g<世代>`。digest は `sha256(requesterUserId+projectId)`）を送る。Agent 側は `.devrelay/sessions/<agentScopeId>/` という scope dir 内の会話状態（conversation.json・claude-session-id 等）のみを読み書きしてよい許可リストに切り替わり（C1 実装、`session-scope.ts`）、他の全項目は deny のまま。`0` のときはサーバーが `statePolicy:'resumable-scoped'`/`agentScopeId` を一切送らず、G 時点（`'isolated'` + 案B前置）と完全同一の挙動になる。`DEVRELAY_CROSS_ASK_ISOLATION=0`（G の緊急ロールバック）のときは本変数の値に関わらず resume も止まる（偶然ではなく明示的な従属）。対象は `cross-ask-runner.ts` 経由（チャット `ask`・WebUI クロスタブ）のみ、`routes/document-api.ts`（ask-member REST/スキル経路）は対象外（isolated のまま。scope dir を触らないため実害なし） |
| DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS | 上記 resume の世代 TTL（既定 `14` 日、clamp 1〜365、`0` で無効）。最終ターンからこの日数を超えたら ask 前に新しい世代（`-g<N+1>`）へ切り替え、旧世代の scope dir は残したまま新規に案B前置を1回だけ載せて継続する |
| DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS | 上記 resume の世代あたり上限往復数（既定 `40`、clamp 2〜500、`0` で無効）。超過時も TTL と同じ世代切り替えで対応（会話が伸び続けてトークン消費が無制限に増える歯止め。課金主体は所有者のまま変更なし） |
| DEVRELAY_DB_CHANGE_WARN | サイクルM1（2026-11-12）: 起動時（`app.listen()` より前）に `apps/server/db/changes/` の未適用 DB 変更を検査し、起動ログに警告を出すか（既定 `1`。`0` で検査自体を無効化するキルスイッチ。fail-open＝台帳なし・権限不足・DB 接続不能のいずれでも起動は続行する）。詳細 `doc/db-changes.md` |
| DEVRELAY_PLAN_GATE_CAPABILITY | サイクルS1（2026-11-12）: プランモードの既存バグ根治（下記 `'plan-gate-hook'` capability）に伴うサーバー側 fail-closed 判定のキルスイッチ。既定 `1`。`1` のとき、クロスユーザー ask（`cross-ask-runner.ts`・`document-api.ts`・`api.ts`/`cross-ask-target-state.ts`）と MCP `ask_project`/`get_answer` の `readOnlyEnforced` 判定が、宛先 Agent の `'plan-gate-hook'` capability 申告を見る（未申告なら ask を断る／`readOnlyEnforced:false` を返す）。`0` にすると、この capability チェックだけを無効化し常に申告済み扱いにする（`'cross-ask-isolation'` capability のチェックには影響しない）。PreToolUse フック自体（Agent 側の実装）にはキルスイッチを置かない方針のため、本変数は Agent の実際の挙動を変えない — サーバー側の判定だけを戻す緊急ロールバック用（真因・配布判断の詳細は `doc/plan-gate-hook-plan.md`） |
| DEVRELAY_BRIEF_REPLY | AI 回答契約サイクル（2026-11-23 改訂）: AI に「人間向け本文」と「詳細」を分けて書かせる契約をプロンプト先頭に前置するか（`sendPromptToAgent()` が Backlog 行と同じ場所で差し込む。Agent 更新 `u` 不要）。振り分け基準は行数・書式ではなく「人間が仕事を進めるために必要か」の一点（`rules/devrelay.md` の「回答の書き方」節が本文）。本変数は前置に加えて、配信側の分割処理（`services/response-split.ts`）全体のキルスイッチも兼ねる＝既定 `1`。`0` のとき: 前置をやめ、かつ配信側も分割せず `Message.content` をそのまま出す（AI が境界行 `<!-- devrelay:detail -->` を書いても無視される。情報を落とさない方針のため、分割だけ止めて詳細を隠すことはしない）。terminalMode・クロスユーザー ask・引継ぎターンには前置自体を元々付けない。恒久版の Agreement テンプレート統合は別サイクルの follow-up |
| DEVRELAY_RESPONSE_SHARE | AI 回答契約サイクル: AI が分けて書いた（または `DEVRELAY_REPLY_SUMMARY` が生成した）「詳細」をログイン不要の公開ページ（`GET /api/public/response/:token`・WebUI `/s/:token`）に置くか。**既定 `0`（OFF）**（`DEVRELAY_CROSS_TEAM` 等と同じ方向。新しい信頼境界を黙って開けないため）。`1` のとき、詳細があるターンは WebUI・Discord・Telegram **共通**で本文から詳細を切り出し、詳細ページへのリンクを本文内に `markdown` 形式（`[詳細を見る（N日間有効）](URL)`）で埋め込む（2026-11-23 実機検証で発覚: `shareUrl` を別フィールドだけで渡す設計だとモバイルアプリ等そのフィールドを知らないクライアントでリンクが消える事故があったため、本文埋め込みに統一）。公開されるのは応答本文のテキストのみ（添付ファイル・ユーザー入力・他メッセージは出さない）。`DEVRELAY_BRIEF_REPLY=0`・`messageId` が無い経路（タイムアウト finalize 等）・一時セッション（`teamexec_`/`crossquery_` 等）・トークン発行失敗・要約失敗では、詳細を隠さずそのまま本文に含めて送る（情報を落とさない）。リンク先ホストは `PUBLIC_URL`（未設定時は既定 `https://app.devrelay.io`、`mcp/oauth.ts` と同じ既定値） |
| DEVRELAY_SHARE_TTL_DAYS | 上記詳細ページの組織既定の保存期間（日、既定 `30`、clamp 1〜365）。devrelay.io はこの変数に `3` を設定する。本人の個人設定（設定画面「共有リンクの保存期間」、`UserSettings` の `response_share_ttl_days`）があればそちらが優先される。期限切れのリンクは 24 時間ごとの定期清掃で `shareToken`/`shareExpiresAt` を null に戻す（`Message.content` 本体は消さない） |
| DEVRELAY_REPLY_SUMMARY | AI 回答契約サイクル第3版（2026-11-23）: AI が境界行 `<!-- devrelay:detail -->` を書かなかった場合に、サーバー側で AI に要約させて「人間向け本文＋詳細リンク」を作る保険機能（`services/reply-summary.ts`）。既定 `1`。`0` で要約を呼ばず `Message.content` をそのまま出す。使う AI プロバイダー・キーは**本人（セッションの持ち主）の個人設定**（設定画面 AI Provider Settings の「返事の要約」、未設定時は「Build Summary」を流用、`SettingKeys.REPLY_SUMMARY_PROVIDER`・`getApiKeyForReplySummary()`）。組織共通キー（`DEVRELAY_ANSWER_API_KEY`）にはフォールバックしない（費用は各自の作業を各自の設定したキーで負担する方針）。本文が `DEVRELAY_REPLY_SUMMARY_MIN_CHARS` 未満・一時セッション・鍵未設定・要約失敗のいずれかなら何もしない（情報を落とさない。元の本文をそのまま出す）。要約結果は `Message.summary` に保存し、履歴の再取得では再要約しない |
| DEVRELAY_REPLY_SUMMARY_MIN_CHARS | 上記要約を試みる本文長の下限（文字、既定 `800`、clamp 100〜20000）。これ未満の本文は要約 AI を呼ばずそのまま出す（短い返事に課金しない） |
| DEVRELAY_ORG_PROVIDER_DEFAULTS | 組織プロバイダー強制サイクル（2026-11-24）: AI プロバイダー設定（`build_summary`/`chat_ai`/`dev_report`/`terminal_ai`/`voice_assist`/`org_summary`/`reply_summary` の7つの `*_provider` 設定）を、既存の組織AIモデル強制（#372、`Organization.aiModelDefaults` + `OrganizationMember.canOverrideAiSettings`）と同じ仕組みで組織が強制できるようにするか。既定 `1`。`0` で従来どおり各自が自由に設定できるキルスイッチ（モデル8キーの強制には影響しない）。API キーは各自のまま（費用は各自）。判定ロジック（`decideEffectiveModel`）・上書き許可フラグは**モデルと共通の1本**＝モデルの上書きを許可されたメンバーはプロバイダーも上書きできる。管理者は設定画面 AI タブの「組織デフォルト」からプロバイダー7件を設定でき、未設定のメンバーにもロック中は組織既定が適用される（＝未設定だった人の機能が組織既定で ON になり各自のキーで課金が始まる点に注意。使いたくない人は個人設定で明示的に「なし」を選べば上書きできる）。組織既定が効いていて個人の API キーが無く機能が止まった場合はサーバーログに警告が1行出る（鍵の材料は出さない）。`l` コマンドの出力にも組織既定のプロバイダー一覧が出る（Discord/Telegram には画面が無いため）。embedding・ナレッジ検索・`DEVRELAY_ANSWER_API_KEY` 系（ナレッジ回答・スレッド自動命名・ポータル要約）は対象外（別のキー解決経路のため） |
| DEVRELAY_THREAD_STATE_BADGE | スレッド状態バッジサイクル（2026-11-24）: スレッド一覧（WebUI 左ペイン・`/lite`・右レール「会話履歴」）に「実行済/プラン/回答済」の3色バッジを出すか。既定 `1`。`0` で `GET /api/threads` が `turnState` を一切出さず（キー省略、旧レスポンスと構造的に同一）、`sendPromptToAgent()` もプラン提示マーカー（`<!-- devrelay:plan -->`）の指示文を前置しない。AI の文章は判定に使わない: 「実行済」は exec ターン完了をサーバー自身が検知した事実（`Session.execCompletedAt`）、「プラン」は AI が機械可読な印を書いたという事実（`Session.planReadyAt`）のみを見る（`services/thread-state-rules.ts`）。印は DB 保存・ライブ配信の両方で表示前に取り除かれる。優先順位は executed > planned > answered（到達した最上位で後退しない）。導入前の既存スレッドは「実行済」のみ既存 `BuildLog` から一度だけ復元済み（0037 マイグレーション）、「プラン」は文章からの推測が危険なため backfill しない（新しいプランから正しく記録される） |
| DEVRELAY_RESTART_GATE | 再起動耐性サイクル（2026-11-25）: `POST /api/services/restart/server` に会話中ガードを付けるか。既定 `1`。`1` のとき実行中の会話（`getGlobalBusyState()`、`/api/machines/:id/restart` と同じ判定ロジック）があれば 409 で断る（body/query の `force:true` で越えられる）。`0` で従来どおり即時再起動。pm2/NSSM の設定変更は不要（予告配信は `services/restart-notice.ts` が担い、停止処理自体の予算に収める方針のため） |
| DEVRELAY_RESTART_NOTICE | 再起動耐性サイクル: サーバー再起動の予告（`web:server:restarting`/`server:restarting`）を全 WebUI・全 Agent へ配信するか。既定 `1`。`0` で配信しない（従来どおり無予告で切断される。クライアント側の無期限リトライによる自力復帰は変わらず効く） |
| DEVRELAY_RESTART_NOTICE_WAIT_MS | `POST /api/services/restart/server` が予告を配信してから実際に再起動コマンドを叩くまでの待ち（既定 `800`、clamp 0〜5000）。WS フレームが OS のネットワークスタックに渡るまでの猶予 |
| DEVRELAY_SHUTDOWN_GRACE_MS | 再起動耐性サイクル: `shutdown()`（SIGINT/SIGTERM/SIGBREAK）全体の予算（既定 `1200`ms、clamp 300〜30000）。pm2 の `kill_timeout`（既定1600ms）・NSSM の停止猶予（既定1500ms）のどちらにも収まる値を既定にしている（設定を伸ばすのではなく処理側を既定値に収める方針）。予算を超えたステップは打ち切って次に進む |
| DEVRELAY_SHUTDOWN_MARKER | 再起動耐性サイクル: 停止処理の自己診断（`apps/server/.runtime/shutdown.json`）を有効にするか。既定 `1`。停止開始時にマーカーを書き、正常完走したら消す。次回起動時にマーカーが残っていれば「前回の停止は途中で強制終了された」警告を起動ログに出す（fail-open）。`0` で診断自体を無効化 |
| DEVRELAY_TURN_RECOVERY | 再起動耐性サイクル: 起動の先頭で「再起動前から実行中だったセッション」を DB から見つけ、①破壊的な起動時メンテナンス（`teamexec_`/`crossquery_`/`raw_` の無条件 ended 化・24h stale 掃除）から除外し、②実行中ターン台帳・進捗トラッカーを復元するか。既定 `1`。`0` で従来どおりの無条件掃除・出力ロストに戻るキルスイッチ（`services/turn-recovery.ts`） |
| DEVRELAY_PROGRESS_REARM | 再起動耐性サイクル: tracker が無いセッションに出力を受けたとき（サーバー再起動後の late output 等）に進捗トラッカーを作り直すか（`ensureTrackerForLateOutput()`、`session-manager.ts`）。既定 `1`。`0` で従来どおり出力を捨てて「⚠️ No tracker found」のログのみに戻す |
| DEVRELAY_INFLIGHT_STATE_FILE | 再起動耐性サイクル: 実行中の会話件数を `apps/server/.runtime/inflight.json` に5秒間隔で書き出すか（既定 `1`）。`pnpm --filter @devrelay/server restart:when-idle` CLI がこれを読んで「会話が終わるまで待ってから再起動」を判断する（認証無しのローカルファイル読み取りのみ。新しい HTTP エンドポイントは増やさない）。`0` で書き出しを止める（CLI は「状況不明」として扱い、待たずに再起動コマンドを実行する） |

## DB テーブル（概要）

| テーブル | 用途 |
|---------|------|
| User | ユーザー |
| Machine | Agent マシン（deletedAt でソフトデリート、autoUpdate で自動更新、localCommit 等でバージョン表示） |
| Project | プロジェクト（displayName でリネーム可能、terminalMode で PTY 経由 claude 起動） |
| Session | 作業セッション（= MCP submission。`autoTitle` は AI が付けたスレッド表示名（0033、ユーザー命名の `title` が優先）。`kind`='question' で ask_project の質問ターン、`cancelledAt` で cancel_submission の取消 claim。`handover*` 列でスレッド引継ぎ `n` の引継ぎ元・引継ぎ書を保持。`execCompletedAt`/`planReadyAt`（0037）はスレッド状態バッジ用。サーバーが検知した事実のみを記録） |
| Message | 会話メッセージ（`shareToken`/`shareExpiresAt` は AI 回答契約サイクルの公開共有リンク、既定 OFF。`summary` は境界行が無い場合の AI 要約キャッシュ） |
| BuildLog | ビルド履歴 |
| MessageFile | メッセージ添付ファイル（bytea BLOB + pgvector embedding） |
| UserSettings | ユーザー設定（API キー等） |
| ChannelSession | チャンネルごとのセッション |
| PlatformLink | プラットフォーム連携 |
| Team | 名前付きチーム（クロスプロジェクトクエリ用グループ） |
| TeamMember | チーム内プロジェクト（Team → Project 参照） |
| ToolApproval | ツール承認履歴（exec モードの canUseTool 記録） |
| Notification | プッシュ通知履歴（モバイルアプリの通知一覧・バッジ管理。`projectId`/`project` は null 許容＝2026-11-02 以降、FCM トークン削除・配信先0件スキップ等 Project に紐づかない `type='error'` 通知に使う） |
| KnowledgeChunk | 高辻ナレッジ: 会話ターン（AI 応答＋直前の人間入力）の検索用チャンク（キーワード ILIKE + pgvector ベクトルのハイブリッド検索。FK は張らない） |
| UserClearance | 高辻ナレッジ サイクル2: 人の権限（`readLevel`/`writeLevel` 0〜10、`compartments String[]`。行が無ければ既定値 0/0/[]。`userId` unique、FK なし） |
| UserUsageGroup | Usage サイクル: 人のグループ（CIT / BIT 等、1人1つ。`userId` unique、FK なし。行が無ければ「タグなし」）。スレッドの案件は `Session.usageCase`、サイネージ URL の鍵は `Organization.usageSignageToken` |
| PortalTodo | ポータル P1（TISA0003、会社リポジトリのみ）: ポータル右カラムの「自分の TODO」。本人のみ読み書き（1 人 100 件・200 文字まで、FK なし） |
| CrossTeamInvite | クロスユーザー Team（Phase 1）: 別ユーザーへの招待（pending の持ち場。`status` は認可判定には使わない、認可は常に CrossTeamGrant の存在のみ） |
| CrossTeamGrant | クロスユーザー Team（Phase 1）: 認可の唯一の根拠（行が存在し `revokedAt IS NULL` ⇔ 承認済み。`askAllowed`/`execAllowed` 既定 false。TeamMember 削除で Cascade） |
| CrossTeamAuditLog | クロスユーザー Team（Phase 1）: 監査ログ（append-only、FK 無し。`action`: request/denied/completed/failed/invite_*/grant_revoked/team_published/team_unpublished/subscribed/unsubscribed/subscription_revoked。公開型追加分は Phase A） |
| TeamSubscription | 公開型クロスユーザー Team（Phase A、2026-11-08）: 購読。認可の根拠は「行が存在し `revokedAt IS NULL`」の2条件のみ（`CrossTeamGrant` と同じ設計原則）。`CrossTeamGrant` とは別テーブルで実 grant 行は作らない（購読のたびに合成するだけ。`Team.visibility='organization'` が前提） |
| DbChange | サイクルM1（2026-11-12）: DB 変更の適用台帳。`apps/server/db/changes/NNNN_*.sql` の各ファイルが末尾で自分のファイル名（`name`、主キー）を記録する。行の存在 ⇔ そのファイルが適用済み。詳細 `doc/db-changes.md` |

## 詳細ドキュメント
- 変更履歴: `doc/changelog.md`
- サイクル別 devlog: `doc/devlog/`（1 サイクル = 1 ファイル + `INDEX.md` 索引）
- DB 変更履歴の一元化（サイクルM1）: `doc/db-changes.md`
- 設計・アーキテクチャ: `rules/project.md`
- マイグレーションガイド: `doc/devrelay-claudemd-migration.md`
- 会社 private リポジトリ clone 対応: `doc/company-repo-sync.md`
