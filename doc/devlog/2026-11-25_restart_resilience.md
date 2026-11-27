# 再起動耐性サイクル（2026-11-25）

## 背景

ユーザー報告: 「devrelayのサーバー再起動って誰かが会話中だと接続切れちゃうよね？」

調査の結論は、接続が切れること自体は Agent・WebUI ともに無期限リトライで自動復帰するため
実害が無い一方、**真の問題は別にあった**:

1. **返事が永久に消える（最大の問題）**: `agents/*/src/services/connection.ts` の
   `sendMessage()` が WS 非 OPEN 時にメッセージを**黙って破棄**していた（else 節なし、
   キューも再送も無し）。サーバー再起動中に AI がターンを完了すると、その完了報告
   （`agent:ai:output` の `isComplete:true`）がちょうどこの瞬間に送られ、DB にも保存されず
   永久に失われていた。
2. **実行中ターンの表示・安全網が消える**: `progressTrackers`/`inFlightTurns`/
   `pendingToolApprovalRequests` が全てプロセス内メモリのため、再起動後は「実行中... N分経過」
   表示・無応答タイムアウトが消え、承認カードも復元できない。
3. **予告が無い**: `shutdown()`（`index.ts`）は `app.close()` を呼ばず close code も送らず
   `process.exit(0)` していたため、クライアントからは異常切断（1006）に見えていた。
4. **既存バグ**: 起動時メンテナンスが `teamexec_`/`crossquery_`/`raw_` の active セッションを
   **無条件で** `ended` にしており、再起動の瞬間に本当に実行中だったクロス ask / MCP exec も
   「終了済み」に巻き戻っていた。

## 方針転換（実装前の2回の確認で変わった点）

- 初回プランは「pm2 の `kill_timeout` を 8000ms に伸ばす」「NSSM の停止猶予を伸ばす」を
  人間の作業として求めていたが、ユーザーから「pm2とか、nssmとか、devrelay中の起動の先頭で
  待つとかでたいおうできないかね？」と指摘を受け、**設定変更ゼロ**で成立する設計に変更した:
  - 予告は「停止信号を受けてから」ではなく「まだ正常稼働しているうちに（再起動を頼む側が）」
    配信する。配信そのものは正常なプロセス内で完了するため、停止猶予の長さと無関係になる。
  - 停止処理自体（予告・`app.close()`・bot 破棄・DB 切断）を `DEVRELAY_SHUTDOWN_GRACE_MS`
    （既定1200ms）で予算管理し、pm2（既定1600ms）・NSSM（既定1500ms）どちらの既定値にも
    収まるようにした。「設定を伸ばす」のではなく「処理側を既定値に収める」方針。
  - 起動の先頭で DB から「再起動前から実行中だったセッション」を見つけ、破壊的な起動時
    メンテナンスから除外し、進捗トラッカー・実行中ターン台帳を復元する。

## 実装（Phase 1: サーバー + WebUI）

- `services/global-busy.ts` は作らず、`auto-updater.ts` に `getGlobalBusyState()` を追加
  （`getMachineBusyState()` のマシン単位判定を全マシンに広げた版。判定ロジック・純関数
  （`resolveBusyState`/`decideManualUpdate`/`buildBusyHoldApiMessage`）は無改造で再利用）。
- `in-flight-turns.ts` に `countAll()` を追加（全マシン合計、既存 `count()` の集計のみ）。
- `services/restart-gate-rules.ts`（新規・純関数）: `DEVRELAY_RESTART_GATE` の解釈のみ。
- `services/restart-notice.ts`（新規）: 全 WebUI・全 Agent への予告ブロードキャスト
  （`web:server:restarting`/`server:restarting`）。`DEVRELAY_RESTART_NOTICE`/
  `DEVRELAY_RESTART_NOTICE_WAIT_MS`。
- `services/shutdown-marker.ts`（新規）: 停止処理の自己診断。`apps/server/.runtime/shutdown.json`
  に停止開始時刻を書き、完走したら消す。次回起動時に残っていれば「前回の停止は途中で
  強制終了された」警告を出す（fail-open）。
- `services/inflight-state-file.ts`（新規）: `apps/server/.runtime/inflight.json` に
  `getGlobalBusyState()` の結果を5秒間隔で書き出す。認証無しのローカルファイル読み取りのみ
  （新しい HTTP エンドポイントは増やさない）。
- `services/turn-recovery.ts`（新規）: 起動の先頭で「active セッションの直近メッセージが
  `role='user'`（まだ AI の返信が無い）かつ `PROGRESS_HARD_TIMEOUT`（既定150分）以内」を
  DB から検出し、①破壊的な起動時メンテナンス（`teamexec_`/`crossquery_`/`raw_` の無条件
  ended 化、24h stale 掃除）から除外、②`inFlightTurns.start()` + `ensureTrackerForLateOutput()`
  で復元する。
- `services/session-manager.ts`: `ensureTrackerForLateOutput()` を追加。tracker が無い
  セッションに出力が来たとき（再起動後の late output 等）に tracker を作り直す
  （`startProgressTracking()` と共通部分を `buildTrackerSkeleton()` に抽出）。
  `appendSessionOutput()` はこれを使うよう変更（従来は「⚠️ No tracker found」で捨てるだけ）。
- `routes/api.ts`: `POST /api/services/restart/server` に会話中ガード（`getGlobalBusyState()`
  + `decideManualUpdate()`、`POST /api/machines/:id/restart` と同じパターン。`force:true` で
  越えられる）と予告配信（`broadcastRestartingNotice()` → `DEVRELAY_RESTART_NOTICE_WAIT_MS`
  待ってから `SERVICE_RESTART_CMD` を実行）を追加。`GET /api/services/status` に
  `busy`/`busyReason` を追加。
- `index.ts`: `shutdown()` を予算管理型に再構成（予告配信 → `app.close()` → bot 破棄
  → Prisma 切断、各ステップを `DEVRELAY_SHUTDOWN_GRACE_MS` の残り予算でレース）。
  起動時に `findInFlightCandidates()` → 破壊的メンテナンスから除外 → `restoreSessionParticipants()`
  → `recoverInFlightTurns()`。`startInflightStateFile()` を定期スイープ群に追加。
- `apps/server/src/scripts/restart-when-idle.ts`（新規）: `apps/server/.runtime/inflight.json`
  を読み、会話が終わるまで待ってから `DEVRELAY_SERVICE_RESTART_CMD` を実行する CLI
  （`pnpm --filter @devrelay/server restart:when-idle`。`--status`/`--force`）。
  HTTP 経由（システム管理者トークンが要る）ではなくローカルファイルを直接読むことで、
  新しい認証の仕組みを増やさない（シェルに入れる＝既にそれだけの信頼がある、という
  既存の `db:status` と同じ前提）。
- `packages/shared/src/types.ts`: `ServerToAgentMessage` に `server:restarting`、
  `ServerToWebMessage` に `web:server:restarting` を追加。
- `apps/web/src/hooks/useWebSocket.ts`: `web:server:restarting` 受信で `onServerRestarting`
  コールバック + 次の close を 1 秒固定で即再接続（バックオフを進めない）。
- `apps/web/src/pages/ChatPage.tsx`: 再起動予告バナー（ヘッダー直下、`serverRestarting` state）。
  `SettingsPage.tsx` の再起動ボタンは 0 行変更（既存の `err.message` 表示が 409 文言を
  そのまま表示する、`/api/machines/:id/restart` と同じ構造）。

## 実装（Phase 2: Agent 送信キュー、3 OS 共通）

- `outbox-rules.ts`（新規、`agents/{linux,macos,windows}/src/services/` に同一内容を配置）:
  `decideOutboxAction()`（メッセージ種別ごとの方針。完了報告・ツール承認要求は `queue-must`、
  途中出力は `queue-best-effort`、`agent:ping`/`agent:connect` は `drop`）、`trimOutbox()`
  （上限超過時に best-effort から古い順に間引く。既定200件・50MB）。
- `connection.ts`（3 OS）: `sendMessage()` が WS 非 OPEN 時に outbox へ積むよう変更
  （従来は else 節無しで黙って破棄）。`server:connect:ack` 受信（machineId 確定 = サーバー側の
  参加者復元も完了済み）で `flushOutbox()`。`server:restarting` 受信で `expectRestart` フラグを
  立て、次の `scheduleReconnect()` は通常の指数バックオフではなく 1 秒固定で即再接続する
  （`reconnectAttempts` は進めない）。
- 重複送信は構造的に起きない: outbox に積むのは「OPEN でなかった」場合だけで、OPEN なら
  即座に送信して積まない。同じメッセージが2回積まれる経路は無い。

## 新規キルスイッチ（全て既定 ON、詳細は CLAUDE.md 本体参照）

`DEVRELAY_RESTART_GATE` / `DEVRELAY_RESTART_NOTICE` / `DEVRELAY_RESTART_NOTICE_WAIT_MS`（既定800）
/ `DEVRELAY_SHUTDOWN_GRACE_MS`（既定1200） / `DEVRELAY_SHUTDOWN_MARKER` / `DEVRELAY_TURN_RECOVERY`
/ `DEVRELAY_PROGRESS_REARM` / `DEVRELAY_INFLIGHT_STATE_FILE`

DB 変更なし。

## 会社サーバー（NSSM）への適用で必要な作業

**設定変更は不要。** `DEVRELAY_SERVICE_RESTART_CMD`/`.env` もそのまま。`restart-when-idle` CLI
は `DEVRELAY_SERVICE_RESTART_CMD` を読むだけなので、`C:\tools\devrelay-restart.cmd` を使う
既存の仕組みに無改造で乗る。`doc/onprem-windows-setup-guide.md` の Step 7 に追記済み。

## 検証

- `pnpm -r build` 全6ワークスペース green。
- `apps/server`: node --test 2314/2314 green（新規 outbox-rules 相当の `restart-gate-rules`/
  `restart-notice`/`shutdown-marker`/`turn-recovery`/`in-flight-turns.countAll` のテスト含む）。
- `apps/web`: node --test 1126/1126 green（`ChatPage.tsx` 行数ピンを実測値 4742 に更新。
  `countLines()` は `split('\n').length`＝末尾改行込みで `wc -l + 1` であることに注意）。
- `agents/linux`: node --test 1841/1841 green（新規 `outbox-rules.test.mjs` 含む）。
- `agents/macos`: node --test 930/930 green（同上。既存の `/tmp` 競合による pre-existing flaky
  test を確認済み——未改造のコードでも並列実行で確率的に別ファイルが失敗する。本サイクルの
  範囲外として未対応）。
- `agents/windows`: node --test 232/232 green（新規 `outbox-rules.test.mjs` 含む）。
- web バンドルに `require(` の CJS 混入なし（`grep -c 'require(' apps/web/dist/assets/index-*.js` = 0）。
- 実機検証（強制再起動でも応答が届くこと等）は未実施。次回の実機再起動時に確認する。

## 追補（2026-11-28）: 実機で見つかった2つの不具合とその修正

実機で `pnpm --filter @devrelay/server restart:when-idle` を試したところ、2つの使い勝手の問題が見つかった。

1. **「誰も会話していないはず」なのに busy と出る**: 実際には3段目の判定（直近 N 分以内に
   `role='ai'` の Message があるだけで busy とみなす冷却期間）が、チャットでこの CLI について
   質問している会話自身に反応していた。さらに別の実機確認では、本当に別マシン（`shiren-ai`）が
   会話中だったが、件数表示（`busy (in-flight turn: 1)`）だけでは「誰か」が分からず、
   Pulse 画面と見比べて初めて正体が分かった。
2. **冷却期間 10 分が長すぎる**: この3段目はもともと `u`（Agent 自己更新）が「AI 応答直後は
   Agent プロセスを触らない」ための安全マージンとして持っていた `RECENT_ACTIVITY_MS`（10分）を
   そのまま流用していたため、チャットから再起動を頼むと、その応答自体が再起動を10分間
   止め続けてしまう罠になっていた。

### 対応

- `restart-gate-rules.ts` に `resolveRestartIdleCooldownMs()` を追加。再起動ガード専用の
  冷却期間を `DEVRELAY_RESTART_IDLE_COOLDOWN_MS`（既定 **10000ms＝10秒**。ユーザー指定）に
  分離した。`getGlobalBusyState()` の3段目だけがこれを使い、`getMachineBusyState()`（`u` 用、
  10分のまま）は無改造。
- `inflight-busy-detail.ts` を新設。`getGlobalBusyDetails()` が `getGlobalBusyState()` と
  同じ優先順位（①実行中ターン台帳→②進捗トラッカー→③直近AI出力）で、busy の根拠となっている
  マシン名・プロジェクト名・スレッド見出し（`title` ?? `autoTitle` ?? 直近メッセージの先頭）を
  解決する。判定ロジック自体（busy かどうか）は複製せず、表示専用の追加情報だけを作る。
- `inflight-detail-rules.ts` を新設（外部 import ゼロの純関数）。`DEVRELAY_INFLIGHT_DETAIL`
  （`off`/`id`/`label`、既定 `label`）の解釈・経過時間の整形・見出しの切り詰め・CLI 表示1行の
  組み立てを持つ。
- `inflight.json` に `sessions` キーを追加（既存キーは無改造＝後方互換）。合わせてファイル
  権限を **0o600**（所有者のみ読み書き）に変更した。これまで誰でも読める 644 だったため、
  スレッド見出し（会話の内容）を載せる前に締める必要があった（既存ファイルへも書き込みの
  たびに `chmodSync` で揃える）。
- `restart-when-idle.ts` の `--status`・待機表示を内訳一覧に対応。`sessions` が無い（旧ファイル・
  `off` レベル）場合は従来の件数表示にフォールバックする。待機中は経過時間だけが進む5秒ごとの
  連打を避けるため、内訳（マシン名・プロジェクト名・見出し）が変化したときだけ再表示する。

### 検証

```
cd /opt/devrelay
pnpm build
node --test apps/server/tests/inflight-detail-rules.test.mjs
node --test apps/server/tests/inflight-state-file-wiring.test.mjs
node --test apps/server/tests/restart-gate-rules.test.mjs
```

`getGlobalBusyDetails()`/`resolveSessionLabels()` は DB に依存するため、`turn-recovery.ts` と
同じ方針で単体テストは置かず、実機確認に委ねる（`inflight-state-file-wiring.test.mjs` は
ファイル権限・`off`/`id`/`label` の出し分けをソースコードから静的に固定するのみ）。
