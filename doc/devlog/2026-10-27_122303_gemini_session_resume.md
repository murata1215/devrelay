# gemini plan→exec resume（MCP approve_implementation の planAiSessionMissing 根治） (2026-10-27)

## 経緯

ユーザー所有の gemini プロジェクト（Session `cmvpw03bd00mlson4w38xll43`）で MCP `approve_implementation`
が必ず `planAiSessionMissing` で弾かれる事象を調査した。`planTurnId` はあるが `planAiSessionId=null`。

## 調査

サーバーは本当にツール非依存で、`aiSessionId` が完了報告に乗りさえすれば無改造で保存・resume できる
（`shouldRecordPlanAiSession()` / `evaluateApproveGuard()`、`apps/server/src/services/submission-guard.ts`）。
真因は Agent 側の未実装だった: `agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐は
**AI セッション ID の概念を一切持たず**、`result.extractedSessionId` に代入する箇所が無く（claude SDK は
`m.session_id`、codex は `thread.started` イベントから拾う）、`options.resumeSessionId` も読んでいない。

本日の実機検証（母艦、gemini-cli 0.65.0）で以下を確認した。

| 検証 | 結果 |
|---|---|
| `gemini --help` | `--session-id <uuid>`（新規・事前採番）/ `-r, --resume <uuid>` の両方に対応 |
| `--session-id <uuid> -p ...` | exit 0。`~/.gemini/tmp/<project>/chats/session-*.jsonl` に記録される |
| `--resume <uuid> -p ...`（ヘッドレス） | **exit 0、文脈が継続する**（別プロセスで「覚えておいて」→「それは？」が通る） |
| 同じ `--session-id` を再利用 | **exit 42**、stderr `Error starting session: Session ID "<uuid>" already exists. Use --resume to resume it, or provide a different ID.` |
| 存在しない `--resume <uuid>` | **exit 42**、stderr `Error resuming session: Invalid session identifier "<uuid>".` |
| セッション保存先 | cwd（プロジェクト）単位。plan/exec は同じ `projectPath` で起動するため問題なし |
| 出力のストリーミング | 初回バイトまで約23秒。60秒無音は gemini にとって異常の証拠にならない |

## 対応

claude 端末モード core#383 と同じ「resume するなら `--resume`、しないなら UUID を事前採番して
`--session-id`」パターンを移植した。4つの設計判断（詳細は `rules/project.md` 参照）:

- **D1**: 新規セッション採番は MCP plan ターン（`options.turnId` がある場合）のみ行う。`turnId` を送るのは
  `submit_instruction` だけのため、chat ターンの argv は従来と1バイトも変わらない。
- **D2**: resume は `decideResume()` の `source === 'explicit'`（サーバー明示指定）のときのみ使う。
  `'stored'`（チャット前ターンの保存 ID）まで使うと、同一チャットで claude→gemini とツールを切り替えた
  場合に別ツールの ID を渡して exit 42 になるため。
- **D3**: resume 失敗（exit 42）は明示検知して `resumeFailed` に乗せ、既存のリトライ機構
  （プラン本文再注入 + `--resume` 無しでの再実行）に合流させる（静かなフォールバック禁止、#325）。
- **D4**: gemini は 60 秒 `RESUME_STARTUP_TIMEOUT` watchdog の対象外にする（ツール非依存の既存 watchdog
  が `resumeSessionId` の有無だけで発火するため、実測23秒かかる gemini の exec ターンを誤 kill する
  危険があった）。

### `packages/shared/src/gemini-args.ts`

- `GeminiCapabilities` に `sessionId` / `resume` を追加、`parseGeminiCapabilities()` で判定。
- `buildGeminiSessionArgs({ caps, resumeSessionId, newSessionId, droppedFlags })`: resume 優先 → 新規採番 →
  何もしない、の相互排他ロジック（`decideTerminalSessionArgs()` と同形）。ID は `isUuidLike()` で形式検証
  してから argv に渡す（gemini は `shell: true` で起動するため、`-m` の `safeModelArg()` と同じ理由）。
- `resolveGeminiAiSessionId({ producedOutput, newSessionId, resumeSessionId })`: 出力ゼロのターンでは
  常に undefined を返す fail-closed（`resolveTerminalAiSessionId()` と同形）。
- `classifyGeminiSessionFailure({ exitCode, stderr })`: 実機 stderr 文言2種 + exit 42 で
  `'sessionIdAlreadyExists' | 'resumeInvalid' | 'none'` を分類。

### `agents/{linux,macos,windows}/src/services/ai-runner.ts`

- gemini 分岐で承認モード argv の直後に `buildGeminiSessionArgs()` を呼び、`--resume`/`--session-id` を
  追加。使った ID は関数スコープの `geminiSessionIdUsed`/`geminiResumedSessionId` に保持。
- `proc.on('close')` の先頭で `result.extractedSessionId = resolveGeminiAiSessionId(...)` を設定。
  これにより既存の全完了経路（`onOutput(..., result.extractedSessionId)`）が自動的に ID を運ぶ。
- `RESUME_STARTUP_TIMEOUT` の arm 条件に `&& aiTool !== 'gemini'` を追加（windows にはこの watchdog 自体が
  存在しないため対象外）。
- `geminiUnknownArgMatch`（Phase 2 の自動リトライ、#329 と同系）のフラグ写像に `--session-id`/`--resume`
  を追加。probe 誤判定時も既存の `geminiDroppedFlags`（同じ上限2個）経由で自己修復する。
- `classifyGeminiSessionFailure()` の分岐を追加し、1行通知 + `result.resumeFailed = true` で
  connection.ts の既存リトライに合流。

### `agents/{linux,macos,windows}/src/services/connection.ts`

- `decideResume()` の戻り値を `sendOptions.resumeSource` として渡す。
- `resumeFailed` リトライの `retryOptions` では `resumeSource` を渡さない（`resumeSessionId: undefined`
  と対で新規セッション扱いにする）。

### `packages/shared/src/i18n.ts`

`gemini.sessionIdUnsupported` / `gemini.resumeUnsupported`（probe で取得した実バージョンを文言に埋め込む）、
`gemini.resumeInvalid` / `gemini.sessionIdCollision` を追加。

### `apps/server/src/services/submission-guard.ts`

- `PLAN_RESUME_CAPABLE_AI_TOOLS = ['claude', 'codex', 'gemini']` を新設。
- `planAiSessionMissing` の文言を出し分け: `aiTool` が上記リストに含まれる（gemini 含む）か、または
  `aiTool` 未指定（既存呼び出し元・旧テスト互換）の場合は従来文言のまま。明示的に非対応ツール
  （devin/aider 等）と分かる場合のみ「plan→exec の引き継ぎ（resume）にまだ対応していません。画面/
  チャットから `e` を送ってください」という新文言に切り替える。
- 呼び出し側（`apps/server/src/mcp/tools.ts`）は無変更。Prisma の `Session` が元々 `aiTool` フィールドを
  持つため、`session` をそのまま渡すだけで構造的に流れ込む（`kind`/`cancelledAt` と同じ扱い）。

### キルスイッチ

新規 `DEVRELAY_GEMINI_SESSION_ID`（既定 `1`。`0` で `--session-id`/`--resume` を一切付与しない旧挙動に戻す）。
既存 `DEVRELAY_GEMINI_YOLO` / `DEVRELAY_GEMINI_TRUST_WORKSPACE` は無変更。

## やらないこと

- chat 経路（画面から `e`）の gemini を本物の resume にする session-store 対応はしない（MCP 経路だけ）。
- devin の resume 対応はしない（文言の出し分けだけ）。
- DB スキーマ変更なし。
- `needsHistoryInPrompt`（gemini は履歴を常にプロンプトに注入）は変更しない。resume と二重に文脈が
  入るが、resume が空振りしたときにプランを失わない安全側を維持する。

## テスト

- `packages/shared/tests/gemini-args.test.mjs`: 実測 0.65.0 の `--help` 全文を fixture 化し、
  `buildGeminiSessionArgs`（resume優先/採番/非対応2種/droppedFlags/UUID形式拒否/相互排他の不変条件）・
  `resolveGeminiAiSessionId`（fail-closed）・`classifyGeminiSessionFailure`（実機 stderr 文言そのまま）を
  追加。15テスト→39テストに拡充。
- `agents/{linux,macos,windows}/tests/gemini-session-resume.test.mjs`（新規）: source-text 回帰テスト
  （`output-callback-tdz.test.mjs` と同じ流儀）。crypto.randomUUID() がその場で呼ばれる・
  RESUME_STARTUP_TIMEOUT の除外条件・resumeSource==='explicit' ガード・turnId 採番条件・
  retryOptions が resumeSource を渡さないこと、を検証（windows は watchdog 自体が無いため該当テストなし）。
- `apps/server/tests/submission-guard.test.mjs`: `PLAN_RESUME_CAPABLE_AI_TOOLS` の内容、
  `aiTool: 'gemini'/'claude'`・未指定→従来文言、`aiTool: 'devin'/'aider'`→新文言、の7テストを追加
  （20テスト→27テスト）。

## 検証

- 3エージェントを個別 `tsc --noEmit` で green。`apps/server` も green。
- `pnpm build`（モノレポ全体）green。
- `pnpm -r test`: `packages/shared` 143/143、`apps/server` 1387/1387、`apps/web` 924/924、
  `agents/linux` 1174/1174、`agents/macos` 736/737（skip1、既知の意図的スキップ）、
  `agents/windows` 155/155、いずれも green（1回目の実行で linux・macos がそれぞれ別ファイルで
  Node test runner IPC の既知 flake（`Unable to deserialize cloned data`）で落ちたが、単体再実行・
  全体再実行で都度 green になり、本変更と無関係と確認済み。過去サイクルの devlog にも同種の記録あり）。

## 反映

- commit + push 必須（`/opt/devrelay` の変更は push しないと Agent に届かない）。
- `apps/server/src/services/submission-guard.ts` / `apps/server/src/mcp/tools.ts` /
  `packages/shared/src/i18n.ts` を変更したため、反映には `pm2 restart devrelay-server` が必要（人間側実施）。
- `packages/shared` と `agents/*` を変更したため、**gemini を使用する全機体で `u` が必須**。
- DB マイグレーションなし。

## 確認したいことへの回答（元依頼より）

- gemini-user 側の Gemini CLI バージョン: `/home/gemini-user` は本ユーザーから読めず、DB にも
  バージョンは保存されていない。直近の記録（`2026-10-27_072248_gemini_workspace_trust.md`）では
  0.65.0 に更新済みとある。`u` 後に1ターン送れば、非対応なら `gemini.sessionIdUnsupported` が
  実バージョン入りで1回だけチャットに出る（対応していれば何も出ず `approve_implementation` が通る）。
  Agent の stdout には従来どおり `[gemini] 🔎 version=... capabilities: ...` が出ており、本サイクルで
  `--session-id`/`--resume` の判定も同じ行に追加された。
- 反映手順: 上記「反映」のとおり。`chatgpt-user` は別コミットで1コミット遅れていたため、今回の
  `u` と合わせて追従させるのが望ましい（本サイクルの変更は codex 経路の argv を変えないが、
  遅れを溜めると切り分けが難しくなるため）。
