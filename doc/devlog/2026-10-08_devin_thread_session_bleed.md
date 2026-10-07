# 2026-10-08 ｜ Devin のスレッド跨ぎ文脈汚染（セッション ID 取り違え）の根治

## 背景

ユーザーから「セッション管理がおかしいって言われた。Devin だけかな？」という報告。
症状: 新規スレッドを押すと新規セッションで始まるのは正常だが、スレッド A で会話中に
スレッド B に切り替えて会話すると、どうも A の内容を引きずる。「そういうものなんだっけ？」
という質問だったが、調査の結果**仕様ではなく Devin 固有のバグ**と判明した。

## 調査で判明した事実

### スレッド分離の仕組み自体は正しく動いている

`Session.agentScopeId`（= スレッド ID）→ Agent 側 `scope-dir.ts` の `resolveScopeDir()` で
`.devrelay/sessions/<agentScopeId>/` という専用ディレクトリに解決される。Claude（SDK の
`session_id`）・Codex（`thread.started` イベントの `thread_id`）はいずれも**自分の run 自身が
返した ID**をそのまま保存するため、スレッドを跨いで取り違える余地が無い。

### Devin だけ「今回のターンのセッション ID」を推測で決めていた

Devin CLI には「今回のターンのセッション ID を直接返す」手段が無く、`ai-runner.ts` は
ターン終了ごとに `devin list --format json` を叩き、「`working_directory` が一致し
`last_activity_at` が最新」の 1 件を無条件にそのスレッドの scope dir へ保存していた
（`agents/{linux,macos,windows}/src/services/ai-runner.ts` の devin ブロック、3 OS 同一コード）。

この方式には 3 つの欠陥があった:

1. フィルタが `working_directory` 一致のみ＝**プロジェクト全体**で、スレッド
   （`agentScopeId`）を識別する情報がどこにも無い。
2. `last_activity_at` が ISO8601 文字列の場合、旧ソート比較器
   `(b.last_activity_at || 0) - (a.last_activity_at || 0)` は `NaN` になりソートが実質
   無効化される（`devin list --format json` の JSON スキーマは Devin 公式ドキュメント
   （`cli/reference/commands`）に記載が無く、数値である保証がない。WebFetch で実測確認済み）。
3. タイムスタンプが正しく数値でも、同一プロジェクトの複数スレッドが並行実行すれば
   先に close した側が相手の ID を拾う。

保存先ディレクトリだけはスレッド単位なので、**「書く場所は正しいが書く値が他スレッドの
もの」**という状態になっていた。破綻シナリオ:

1. スレッド B の 1 通目: scope dir に ID が無い → `-r` なし → 新規セッション（正常に見える）
2. B の 1 通目終了時: `devin list` から A のセッション ID を拾って B の scope dir に保存
3. B の **2 通目**: `-r <A の ID>` で起動 → A の会話が丸ごと復元される

「新規スレッドは新規で始まる」が「切り替えて会話すると引きずる」という報告と完全に一致する。

### 悪化要因

- `#368 Phase2a` で Devin は常に `--permission-mode dangerous` で起動するようになり、
  保存済みモードと必ず一致するため**毎ターン resume が成立する**ようになっていた。
  `rules/project.md` の「`-r` resume は plan モード時のみ」という記載は現状と乖離していた
  （本サイクルで訂正済み）。
- Devin 分岐は `decideResume()`（`resume-priority.ts`）を一切通さず、
  `options.forceNewSession` / `options.resumeSessionId` を無視する。scope dir 以外に
  分離手段が無いため、1 箇所の穴が即座に文脈漏れになる構造だった（この点は未解消、
  「今回スコープ外」として下記に記録）。

## 対策

「推測」をやめて「確定」させる方針で、Agent 側のみを変更（サーバー/WebUI/DB は無変更）。

新規モジュール `agents/{linux,macos,windows}/src/services/devin-session-pick.ts`
（外部 import ゼロの純関数、3 OS byte-for-byte 同一、`sha256sum` で確認済み）:

- `parseDevinSessionList(raw, projectPath)`: `devin list --format json` の生出力を
  `working_directory` で絞り込み正規化。`last_activity_at` は数値 epoch / ISO8601 文字列の
  どちらでも正しく比較できるよう `normalizeActivityMs()` で変換（欠陥2の修正）。
- `pickDevinSessionId({ resumedId, beforeIds, afterEntries, ownedByOtherScope })`:
  - resume したターン（`resumedId` あり）は今回のセッション ID が既知のため `devin list` の
    結果を一切見ない（`reason: 'resumed'`）。
  - 新規セッションのターンは spawn 直前に取得したスナップショット（`beforeIds`）と close 後の
    結果（`afterEntries`）の差分で「今回新しく現れた ID」を特定する（`reason: 'newlyAppeared'`、
    欠陥1の修正）。
  - 差分が取れない（スナップショット自体が失敗）場合のみ従来のタイムスタンプ最新フォールバック
    （`reason: 'latestFallback'`）。差分が複数件（並行実行等）なら `reason: 'ambiguous'` として
    保存を見送る（欠陥3の緩和——検出できないケースは安全側に倒す）。
  - 採用候補が既に別スコープに記録済みなら `reason: 'ownedByOtherScope'` として保存を見送る
    （新設 `session-store.ts` の `listDevinSessionOwners()` で全スコープ dir を走査）。

誤った ID を固定化するより未保存のほうが安全——次ターンは新規セッションになるが、Devin は
非 Claude ツールとして会話履歴を常にプロンプトへ注入する（`connection.ts`）ため、文脈自体は
維持される。

`ai-runner.ts` 側の変更:
- spawn 直前（resume しないターンのみ）にセッション ID 一覧をスナップショット。
- `close` ハンドラの保存ロジックを `pickDevinSessionId()` ベースに差し替え。
- 旧実装の `execSync`（同期・最大10秒ブロック）を `exec`（非同期）に変更し、`close` ハンドラ
  自体も `async` 化（EventEmitter は listener の戻り値を待たないため、他の listener や外側の
  `Promise` executor には影響しない）。resume ターンは `devin list` を一切叩かないため、
  通常運用ではむしろ呼び出し回数が減る。
- `console.log`/`log.info` のセッション ID ログに `(scope: ...)` を追記し、load/save の scope が
  一致しているか `agent.log` 上で突き合わせられるようにした。
- キルスイッチ `DEVRELAY_DEVIN_SESSION_PICK_LEGACY=1`（Agent 実行環境の環境変数）で旧実装
  （無条件最新 1 件採用、同期 `execSync`）に完全に戻せる。新方式に未知の不具合が見つかった
  場合の緊急ロールバック用。

`rules/project.md` の「Devin CLI 統合」節を更新: 「`-r` resume は plan モード時のみ」という
記載を「保存済み permission-mode が今回のターンと一致するときのみ（Devin は常に dangerous
なので通常運用では毎ターン resume）」に訂正し、本件の根治内容を追記。

## テスト

新規 `devin-session-pick.test.mjs`（3 OS 同一内容、17 ケース）:
- `parseDevinSessionList`: 空文字列/不正 JSON/配列でない/working_directory 不一致/
  id 欠落 → 空配列（例外を投げない）。`last_activity_at` の正規化（数値・ISO8601文字列・
  null・不正文字列）。Windows パス区切り・大小文字の正規化。
- `pickDevinSessionId`: resumed優先、newlyAppeared（**ISO8601 文字列3件で旧実装なら
  常に出力順の先頭を返していたケースの回帰**）、latestFallback（beforeIds欠落時）、
  ambiguous（複数新規出現）、ownedByOtherScope（新規/フォールバック両経路）、none。

## 検証結果

- `pnpm --filter @devrelay/shared build` / `agent` / `agent-macos` / `agent-windows` build green
- `devin-session-pick.test.mjs`: linux/macos/windows 各 17/17 green（単体実行）
- フルスイート（クリーン実行時の件数、各 `baseline + 17`）: linux 1066/1066 green、
  macos 630/630 pass+skip1 green、windows 149/149 green。複数回実行すると
  `conversation-store-scope.test.mjs` / `handle-conversation-clear.test.mjs` /
  `file-handler.test.mjs` のいずれかが 1〜2 件だけ落ちる・subtest 総数が数件前後に
  ブレることがあったが、該当ファイルは単体実行では毎回 green（アーカイブファイル名が
  秒単位のタイムスタンプで衝突する既知 flake、本変更とは無関係と特定——該当ファイルは
  今回一切変更していない）。windows は変更（`session-store.ts`/`ai-runner.ts`）を一時的に
  stash した状態でも同じ flake が再現することを確認し、既存問題であることを実証済み。
- `devin-session-pick.ts` の `sha256sum` が 3 OS で完全一致することを確認。

## 今回スコープ外（別サイクル提案）

1. Devin が `forceNewSession`/`resumeSessionId` を無視している（`decideResume()` 未使用）。
   加えて Devin は `extractedSessionId` を設定しないため `Session.planAiSessionId` が常に
   NULL になり、MCP の `approve_implementation` が `planAiSessionMissing` で弾かれる。
2. 全 AI 共通のスレッド跨ぎ: `work_state.json` / `storage-context.md` / `plans/` が
   プロジェクト単位のままプロンプトに注入される（`w` コマンド等を使った場合に効く）。
3. レガシースレッド（`agentScopeId = NULL`、cycle1 以前の Session 行）同士は
   `.devrelay/` 直下を共有するため、ツールに関係なく必ず引きずる
   （バックフィル禁止、`GET /api/threads` の `isScoped: false` で判別可能）。
4. `handleAgreementApply`（`connection.ts`）が `agentScopeId` 無しで `sessionInfo` を作る。

## デプロイ

Agent のみの変更（`agents/linux`・`agents/macos`・`agents/windows`）。`apps/server`・
`apps/web`・Prisma 無変更のため **pm2 restart 不要**。**Devin を使っている機は各機で `u` が
必須**。commit/push 未実施。DB マイグレーション不要。
