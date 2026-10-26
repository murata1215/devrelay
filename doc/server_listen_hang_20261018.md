# サーバー起動ハング障害レポート（2026-10-18）＋対策A実装記録

## 概要

マシン再起動後、`devrelay-server` がポート 3005 で listen せず、Web UI・Agent WebSocket・API が
**約 6.5 時間全停止**した。原因は `app.listen()` より前で Discord/Telegram bot の起動を await していたこと。
対策（下記「対策A」）として、bot の起動を listen 後ろへ移し、無制限リトライの監督ループに置き換えた。

| 項目 | 値 |
|------|-----|
| 発生時刻 | 2026-10-18 02:46（マシン再起動） |
| 検知時刻 | 同日、ユーザーが Web UI にアクセスできないことに気づく |
| 復旧完了 | 同日 09:12（手動 `pm2 restart devrelay-server`） |
| データ損失 | なし（Agent は再接続を 30 回試行して諦めていたが、DB・会話履歴は無事） |
| 対策実装 | 同日、対策A（本ドキュメント）実装 |

検討の経緯・原因分析・対策案の全文は `doc/plans/server-startup-hang-countermeasures.md` を参照。

## 根本原因

`apps/server/src/index.ts` の `main()` が、外部サービスへの接続を `app.listen()` より **前** で await していた。

- `await setupDiscordBot(discordToken)` → 内部で `await client.login()`
- `await setupTelegramBot(telegramToken)` → 内部で `await bot.getMe()`

再起動直後はまだ外部ネットワークに出られず、`client.login()` 内部の `fetchGatewayInformation()`（discord.com への REST 呼び出し）がハングし、`app.listen()` まで処理が進まなかった。

## 対策A（実装済み）

**方針**: `app.listen()` を最優先にし、bot はバックグラウンドで無制限リトライして自力復帰する。外部サービスに繋がるかどうかで DevRelay 本体の起動を左右させない。

### 変更内容

1. **起動順序の変更**（`index.ts`）: bot の起動（トークン取得含む）を `app.listen()` の**後ろ**へ移動。`await` せず `startBotSupervisors()` として fire-and-forget で起動する。
2. **listen 前の処理もすべて非致命・時間制限付きに**（`index.ts`）: 起動時 DB メンテナンス（全マシン offline 化・stale セッション掃除）・`restoreSessionParticipants()`・`initFcm()` を 20 秒上限の `Promise.race` で包み、失敗してもログを出して続行する。`main().catch()` を足すだけだと DB 未起動時に同じ障害（クラッシュループ）が再発するため。
3. **bot 監督ループの新設**（`services/bot-supervisor.ts` + `services/bot-supervisor-rules.ts`）: 1 試行 30 秒タイムアウト、10 秒→最大 5 分の指数バックオフで**無制限**リトライ。無効トークン等の fatal エラーはリトライを打ち切る。
4. **Discord**（`platforms/discord.ts`）: `client` の代入を `ClientReady` まで遅延（送信系関数のガードを 1 行も変えずに「準備中は捨てる」を実現）。世代カウンタで二重応答を防止。`Events.Error` のリスナ未登録バグ（プロセスクラッシュの潜在要因）を修正。
5. **Telegram**（`platforms/telegram.ts`）: `{ polling: true }`（コンストラクタ時点で polling 開始）を `{ polling: false }` → `getMe()` → ハンドラ登録 → `startPolling()` の順に変更。失敗した試行が polling を開始しないため、リトライの 409 Conflict リスクが構造的に消える。
6. **`/health` に `bots` フィールドを追加**: discord/telegram それぞれの `phase`（disabled/connecting/ready/failed）を出す。常に 200 を返す（`scripts/install-agent.sh` が疎通判定に `curl -fsS` を使っているため）。
7. **キルスイッチ**: `DEVRELAY_BOT_SUPERVISOR`（既定 `1`。`0` で 1 回だけ試行して諦める）。調整値 `DEVRELAY_BOT_LOGIN_TIMEOUT_MS` / `DEVRELAY_BOT_RETRY_MAX_MS`。「listen を先にする」こと自体にはキルスイッチを置かない（無効化＝障害の再導入）。

### スコープ外

対策D（Agent の再接続無制限化）は今回実施しない（ユーザー決定）。そのため、サーバーが 15 分以上停止すると Agent は `Max reconnect attempts (30) reached` で再接続を諦め、復旧後もマシンごとの手動再起動が必要な制約は残る。対策A によって「サーバーが長時間 listen しない」という今回の引き金は消えるため、顕在化する確率は大きく下がる。

### 追記（2026-10-18 同日・後続調査）: 本障害が誘発した crontab 破損を発見・根治

実際にこの障害で x220-158-18-103 の Agent 12 体がオフラインのまま復帰しなかった際の
調査で、対策D とは別次元の **DevRelay 本体のバグ 2 件**を発見した。

- `u` 自己更新の crontab 書き換え sed が冪等でなく、`u` を実行するたびに crontab の
  `@reboot` 行が壊れていく（セミコロンが増殖し最終的に構文エラー）。これが「サーバー復旧後も
  12 体が手動復旧なしに戻らなかった」直接の原因（対策D の欠如とは独立した問題）
- systemd unit を書く2経路（`install-agent.sh` / `setup.ts`）のテンプレート乖離

両方とも根治済み（`agents/linux` のみ変更）。詳細は
[devlog](devlog/2026-10-18_144713_agent_reboot_offline_root_cause.md) 参照。
なお対策D 自体（再接続の回数打ち切り）は依然未実施。

## 変更ファイル

- `apps/server/src/services/bot-supervisor-rules.ts`（新規）
- `apps/server/src/services/bot-supervisor.ts`（新規）
- `apps/server/src/platforms/discord.ts`
- `apps/server/src/platforms/telegram.ts`
- `apps/server/src/index.ts`
- `apps/server/tests/bot-supervisor-rules.test.mjs`（新規）

Agent（`agents/*`）・`packages/shared` の変更はゼロ（`u` 不要）。DB スキーマ変更なし。
