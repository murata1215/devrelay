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
# 再起動はユーザーが実行:
pm2 restart devrelay-server
```

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

## DB スキーマ変更時の必須手順
1. `schema.prisma` を変更
2. `cd apps/server && npx prisma migrate dev` を試行 → 失敗時は `npx prisma db execute --stdin` で直接 SQL 適用
3. **カラム存在を SQL で検証**: `npx prisma db execute --stdin <<< "SELECT column_name FROM information_schema.columns WHERE table_name='テーブル名' AND column_name='カラム名';"`
4. `npx prisma generate` で Prisma Client 再生成
5. `pnpm build` でビルド
6. 再起動案内時に「DB マイグレーション適用済み」を明記する

## ポート割り当て規約（90xx 番台）

`/etc/caddy/sites.d` 配下のサイトが使う 9000 番台ポートは、手動作成と `testflight` 自動作成が混在するため、衝突を避けるためレンジを分離している（2026-10-18 `testflight` が手動作成サイトと同じポート 9027 を払い出した衝突事故の根治）。

| レンジ | 用途 |
|---|---|
| 9001-9299 | 手動作成プロジェクト・`testflight` 旧採番の既存サービス（現在 9001-9029 使用中） |
| 9300-9499 | `testflight` の自動採番専用（`DEVRELAY_TESTFLIGHT_PORT_START` で開始位置変更可、既定 9300） |

**新規に手動で Caddy サイトを作る場合は 9001-9299 側からポートを選ぶこと。** `testflight` コマンドは常に 9300-9499 からのみ採番するため、この規約を守れば両者は交わらない。

## 環境変数（apps/server/.env）

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
| DEVRELAY_ANSWER_MODEL | 高辻ナレッジ サイクル4: ナレッジ回答に使う OpenAI モデル名（既定 `gpt-4o-mini`）。provider は常に OpenAI 固定 |
| DEVRELAY_UPDATE_BUSY_GUARD | サイクル3.1: 実行中 AI ターン中の Agent 自己更新保留（`isMachineBusy()` の実行中ターン台帳 + 手動 `u`/`server:agent:restart` の busy ガード）を有効にするか（既定 `1`。`0` で従来挙動に戻すキルスイッチ。Agent 側の D2（`sendPromptToAi()` 実行中は `server:agent:update` を保留する最後の砦）にはキルスイッチを置かず常時有効） |
| DEVRELAY_WEB_COMMAND_PERSIST | WebUI のコマンド入力/応答（`testflight`・`status`・`log` 等の非 AI ターン）を `Message` に保存するか（既定 `1`。`0` で従来どおり WS 配信のみ＝再接続・リロード・スレッド切替で消えるキルスイッチ。AI ターン系（`exec`/`agreement`/`ai:prompt`/`ask:member`/`teamexec:member`）は元々自前で保存しているため対象外、`login*`/`clear`/`quit` も対象外） |
| DEVRELAY_BOT_SUPERVISOR | 2026-10-18 起動ハング対策A: Discord/Telegram bot 起動の監督ループ（`services/bot-supervisor.ts`）が無制限リトライするか（既定 `1`。`0` で「1 回だけ試行して諦める」に縮退するキルスイッチ。`app.listen()` を bot 起動より先に行う起動順序自体にはキルスイッチを置かない＝無効化は障害の再導入のため。詳細 `doc/server_listen_hang_20261018.md`） |
| DEVRELAY_BOT_LOGIN_TIMEOUT_MS | bot 起動 1 回分の試行タイムアウト（既定 `30000`、clamp 5000〜300000） |
| DEVRELAY_BOT_RETRY_MAX_MS | bot 起動リトライ間隔の上限（既定 `300000`、clamp 10000〜3600000） |
| DEVRELAY_CONVERSATION_RAIL | 右レール第3タブ「会話履歴」（直近20スレッド横断・実行中スピナー・未確認緑✓）向けに `GET /api/threads` が `running`/`lastAiAt` フィールドを返すか（既定 `1`。`0` で両フィールドを一切出さない＝旧レスポンスと構造的に同一になるキルスイッチ。DB 変更なし・既読状態はブラウザの localStorage 管理） |
| DEVRELAY_PUSH_DIAG | 2026-10-22 の FCM 無音故障（アプリ再インストール後、配信先の無いトークンへ送信し続けエラーも出ないまま無音で壊れた）の再発防止として追加した診断ログ（配信先 0 件の警告・送信結果1行ログ）を出すか（既定 `1`。`0` で従来どおり無言。`fcm-service.ts`） |
| DEVRELAY_FCM_STRICT_DELETE | FCM トークン削除ポリシーを旧挙動（`invalid-argument` を即削除）に戻すキルスイッチ（既定 `0` ＝安全側。`1` で旧挙動。`invalid-argument` は別 Firebase プロジェクト発行トークン等でも返るため、既定では連続5回失敗するまで削除しない） |
| DEVRELAY_FCM_TEST_API | 設定画面の「テスト通知を送る」が使う `POST /api/push/fcm/test` を有効にするか（既定 `1`。`0` で 404。`GET /api/push/fcm/devices`・`POST /api/push/fcm/verify`・`DELETE /api/push/fcm/devices/:tokenPrefix` には影響しない） |
| DEVRELAY_AGENT_REPO_URL | 会社 private リポジトリ clone 対応サイクル: `GET /api/machines/:id/token` が WebUI に返す、Agent インストール一行コマンドに付与する clone 先 URL（`https://` 必須・userinfo 付き URL は拒否して無視）。**未設定時は WebUI のコマンドが現行と完全に同じ文字列になる**（実質的なキルスイッチ）。PAT はこの変数にも DB にも一切保存しない（Agent PC ローカルの `.git/config` の `http.<repoUrl>.extraHeader` にのみ保存。インストーラ側は `--repo`/`$env:DEVRELAY_REPO_URL`、PAT は `DEVRELAY_REPO_TOKEN`/`$env:DEVRELAY_REPO_TOKEN` または対話入力。詳細 `doc/company-repo-sync.md`） |

## DB テーブル（概要）

| テーブル | 用途 |
|---------|------|
| User | ユーザー |
| Machine | Agent マシン（deletedAt でソフトデリート、autoUpdate で自動更新、localCommit 等でバージョン表示） |
| Project | プロジェクト（displayName でリネーム可能、terminalMode で PTY 経由 claude 起動） |
| Session | 作業セッション（= MCP submission。`kind`='question' で ask_project の質問ターン、`cancelledAt` で cancel_submission の取消 claim） |
| Message | 会話メッセージ |
| BuildLog | ビルド履歴 |
| MessageFile | メッセージ添付ファイル（bytea BLOB + pgvector embedding） |
| UserSettings | ユーザー設定（API キー等） |
| ChannelSession | チャンネルごとのセッション |
| PlatformLink | プラットフォーム連携 |
| Team | 名前付きチーム（クロスプロジェクトクエリ用グループ） |
| TeamMember | チーム内プロジェクト（Team → Project 参照） |
| ToolApproval | ツール承認履歴（exec モードの canUseTool 記録） |
| Notification | プッシュ通知履歴（モバイルアプリの通知一覧・バッジ管理） |
| KnowledgeChunk | 高辻ナレッジ: 会話ターン（AI 応答＋直前の人間入力）の検索用チャンク（キーワード ILIKE + pgvector ベクトルのハイブリッド検索。FK は張らない） |
| UserClearance | 高辻ナレッジ サイクル2: 人の権限（`readLevel`/`writeLevel` 0〜10、`compartments String[]`。行が無ければ既定値 0/0/[]。`userId` unique、FK なし） |

## 詳細ドキュメント
- 変更履歴: `doc/changelog.md`
- サイクル別 devlog: `doc/devlog/`（1 サイクル = 1 ファイル + `INDEX.md` 索引）
- 設計・アーキテクチャ: `rules/project.md`
- マイグレーションガイド: `doc/devrelay-claudemd-migration.md`
- 会社 private リポジトリ clone 対応: `doc/company-repo-sync.md`
