# Windows Agent 移植 事前調査レポート + 移植プラン（#348 / #375 / #376 / #377）

## Context

`agents/windows` は core#376（`9c49644`）/ #377（`8c1dc69`）のコミットに含まれておらず、直近 4 サイクル分の
Agent 層変更が未反映のまま。本サイクルは **read-only 調査のみ**で、
「Linux 構造に寄せる」か「#376 最小移植」かの判断材料を出すことを目的とする。

調査の結果、Windows は単に「遅れている」のではなく、**サーバーが全 OS に等しく送っている
`agentScopeId` / `resumeSessionId` / `turnId` を黙って捨てている**状態にあることが判明した。
つまり Windows マシン上のプロジェクトに対する MCP `submit_instruction` は、
core#336 が解決したはずの「並行 submission が resume 先と会話履歴を取り違える」事故に
今も無防備である。加えて調査中に、当初の想定を覆す 2 つの実測事実が出た（下記 F1/F2）。

---

## 0. 調査で判明した「想定を覆す事実」（最重要）

| # | 事実 | 根拠 | 影響 |
|---|---|---|---|
| **F1** | Claude CLI には `--max-turns <turns>` が **存在する**。`.hideHelp()` されているだけ | SDK 同梱 `cli.js` に `.addOption(new kK("--max-turns <turns>", ...).hideHelp())`（`grep -c` = 1）。`claude --help` の grep が 0 なのは非表示のため | #377 の `resolveSdkMaxTurns()` は Windows でも **dead code にならない** |
| **F2** | CLI の stream-json `result` 行は `subtype` / `is_error` / `num_turns` / `session_id` を **持つ** | `cli.js` に `type:"result",subtype:"success"` / `"error_max_turns"` / `"error_during_execution"` / `"error_max_budget_usd"` / `"error_max_structured_output_retries"` の 5 種すべてを実測 | #377 の `mapResultSubtypeToStopReason()` は CLI 経路でもそのまま使える |
| **F3** | CLI の maxTurns 既定値は **200**（DevRelay の SDK 既定は 400） | `cli.js` の `maxTurns:200` | Windows は Linux の **半分**の閾値で、しかも **無告知**に打ち切られている。#377 は Windows で *より* 価値が高い |
| **F4** | サーバーは OS を問わず scope 3 点を送信済み | `apps/server/src/services/agent-manager.ts:1201,1295,1875` / `apps/server/src/mcp/tools.ts:643,807` | Windows 側の受け口追加だけで完結。**server / shared 変更ゼロ・再起動不要・DB マイグレーション不要** |
| **F5** | Windows は `case 'server:plan:latest'` を持たない（handler 数 17、Linux は 31） | `Grep` 実測 | Windows マシンへの MCP `get_plan` は `PLAN_READ_TIMEOUT = 15000`（`agent-manager.ts:2116`）まで**ハングしてからエラー**になる |

---

## 1. ファイル存在差分

`agents/linux/src/services/` = 43 / `agents/macos/` = 37 / `agents/windows/` = **20**。
macOS は「Linux から Linux 専用 5 本を引いたもの」で完全同期＝**あるべき姿の基準**。

### 本サイクル 4 件に関係する Linux-only モジュール（Windows に無い）

| ファイル | 由来 | Windows |
|---|---|---|
| `scope-dir.ts` | #376 | **無し** |
| `resume-priority.ts` | #376 | **無し** |
| `session-scope.ts` | #348 | **無し** |
| `path-mutex.ts` | #348 | **無し** |
| `atomic-write.ts` | #348 | **無し** |
| `plan-file-store.ts` | #375 | **無し** |
| `sdk-stop-reason.ts` | #377 | **無し** |
| `history-compaction.ts` | #372 | **無し** |

### 対象外（今回は移植しないと判断した Linux-only）
`sdk-loop-guard.ts` / `plan-permission.ts`（いずれも SDK メッセージストリーム・`canUseTool` 前提で
CLI 経路では dead code）、`management-info.ts`、`running-code-stale.ts`、`skill-manager.ts`、
`terminal-runner.ts` / `terminal-parser.ts`（PTY）、`claude-login.ts` / `claude-auth.ts` /
`claude-locator.ts`、`control-response.ts`、`approval-logger.ts`、`update-script.ts`、
`scaffold-templates.ts`、`log-rotator.ts`、`windows-skill-path.ts`。

### Windows-only（削らない）
`logger.ts`（electron-log）、`sleep-preventer.ts`（koffi / PowerSetRequest）。

---

## 2. 共通ファイルの内容差分と由来分類

| ファイル | Linux 側の変更内容 | 由来 | Windows の状態 |
|---|---|---|---|
| `scope-dir.ts` | `resolveScopeDir()` / `isValidAgentScopeId()` 新設 | #376 | **無し** |
| `resume-priority.ts` | `decideResume()`（explicit > forceNew > stored） | #376 | **無し** |
| `session-store.ts` | 全 API に `agentScopeId?` 追加、`getSessionPath()` を `resolveScopeDir()` 経由に。`SessionMeta` / `loadSessionMeta` 追加、`saveClaudeSessionId(path, id, mode?, scope?)` 4 引数化 | #376 | **古い**（`join(projectPath,'.devrelay',F)` フラット、`session-store.ts:27-29`）。devin/codex/context-usage 系は同等 |
| `conversation-store.ts` | 5 exported + 1 private に `agentScopeId?`、`mutateConversation()` によるロック更新 | #376 + #348 | **古い**（パス解決 3 箇所: `:22-24`, `:56` インライン, `:136`） |
| `ai-runner.ts` | `OutputCallback` 3→5 引数（`extractedSessionId` / `stopReason`）、`decideResume()`、`mapResultSubtypeToStopReason()`、`resolveSdkMaxTurns()` | #376 + #377 | **古い**。`:388` は 3 引数。`:1257` の result 分岐は `duration_ms` をログするだけで `subtype`/`is_error`/`num_turns` を**捨てている** |
| `connection.ts` | scope 配線（`SessionInfo.agentScopeId`）、`isEphemeralSession()` ゲート、`persistPlanFile()`、`handlePlanLatest()`、5 引数コールバック伝播 | #348 + #375 + #376 + #377 | **古い**。handler 17（Linux 31）。3 つの payload 型（`:350`,`:490`,`:559`）が scope 3 点を宣言していない |
| `devin-atif.ts` / `devin-plan-prompt.ts` / `git-guard-core.ts` / `cli-failure.ts` | #374 まで反映済み | #374 | **同等**（`diff -q` で byte 一致を実測） |
| `output-parser.ts` / `output-collector.ts` / `file-handler.ts` / `work-state-store.ts` / `projects.ts` / `agent-state.ts` / `config.ts` | 軽微な差（コメント言語等） | — | 本サイクル対象外 |

**#375 の Windows 影響**: `plan-file-store.ts` が無い＝保存側が無い。加えて F5 のとおり
読み取り側 `server:plan:latest` も無いため、`get_plan` は 15 秒ハング。

---

## 3. 構造差（Linux をそのまま持ち込めない箇所）

### 3-1. 実行モデル: SDK vs CLI
- Linux/macOS: `@anthropic-ai/claude-agent-sdk` の `query()`（`agents/linux/src/services/ai-runner.ts:33-34`）
- Windows: SDK 依存**ゼロ**。`claude` を `--output-format stream-json --verbose` + `shell: true` で spawn
  （`agents/windows/src/services/ai-runner.ts:569-633`, `:621-632`）

→ **F1/F2 により、この差は #377 の障害にならない。** `--max-turns` はフラグとして渡せ、
`subtype` は result 行から読める。`sdk-stop-reason.ts` は byte-for-byte コピーで機能する。

### 3-2. `forceNewSession` / `--resume`
Windows の resume 失敗検知は `code === 1 && fullOutput.length === 0 && options.resumeSessionId`
（`ai-runner.ts:1593`）で、Linux の `is_error && resumeSessionId` ヒューリスティックとは別物。
max-turns 打ち切りは **exit 0 + 出力あり**なので、#377 の根本バグ
（`error_max_turns` が `resumeFailed` に食われて全プロンプト再実行）は **Windows では再現しない**。
→ Windows の #377 は「可視化のみ」で足り、`resumeFailed` ロジックは触らない。

### 3-3. `resolveScopeDir()` の接頭辞検証と Windows パス
```ts
// agents/linux/src/services/scope-dir.ts:65
if (scopedDir !== scopedRoot && !scopedDir.startsWith(scopedRoot + sep)) { throw ... }
```
`sep` は `path` からの import（`:1`）なので Windows では `'\\'` に解決され、`resolve()` の出力とも整合する。
かつ `agentScopeId` は `/^[A-Za-z0-9_-]{1,128}$/`（`:35`）で `/` `\` `.` を排除済みなので、
`scopedDir` は必ず `scopedRoot` の直下 1 階層。**ドライブレター混在も UNC も発生し得ない**
（両者とも同じ `projectPath` から `resolve()` される）。
→ **Windows 向け改変は不要。byte-for-byte コピー可**。

### 3-4. `atomic-write.ts` の Windows 実機未検証（最大リスク）
`atomic-write.ts:7-13` に「Windows での `fs.rename` 上書き挙動は実機未検証」と明記されている。
実装は防御的（unlink→rename→20/60/150ms リトライ→直接 write + 必ず `console.warn`）なので
最悪でも警告 1 行に落ちる。**単独サブサイクルで投入して切り分け可能にする。**

### 3-5. logger 差分
electron-log を import しているのは 4 ファイルのみ
（`services/logger.ts` / `ai-runner.ts:14` / `connection.ts:33` / `electron/main.ts:9`）。
**移植対象の純モジュール・ストア層は 1 つも logger を使っていない**
（Windows の `conversation-store.ts` / `session-store.ts` は Linux と同じく `console.*`）。
→ byte-for-byte コピー不可なのは **`connection.ts` と `ai-runner.ts` の 2 本のみ**（手編集）。

### 3-6. JSDoc 不変条件の齟齬
`scope-dir.ts:20` と `resume-priority.ts:15` は既に「linux と macos と **windows** で
byte-for-byte 同一」と宣言済み。一方 `session-scope.ts:13` / `path-mutex.ts:11` /
`atomic-write.ts:17` は「linux と macos」止まり。
→ この 3 本をコピーするサイクルで、**3 OS 全部の同 1 行を同時に直す**（でないと byte 同一と
コメントが両立しない）。

---

## 4. テスト基盤

| | Linux | macOS | Windows |
|---|---|---|---|
| `tests/` | 26 本 `.mjs` | 23 本 | **無し** |
| `package.json` の `test` | `node --test tests/`（`:14`） | あり | **無し** |
| import 元 | `../dist/services/*.js`（コンパイル済み） | 同 | — |

`agents/windows/tsconfig.json` は `agents/linux/tsconfig.json` と **byte 一致**
（`extends ../../tsconfig.json` / `outDir ./dist` / `rootDir ./src`）。root は `target ES2022` /
`module NodeNext`。`agents/windows/dist/services/*.js` も既に同じ形。
→ **Linux のテストは verbatim コピーで動く**。`package.json` に 1 行足すだけ。
root `pnpm -r build` は既に `agents/windows` を含むので、**この Linux 機で全サブサイクルを検証できる**。

---

## 5. 仕分け: byte-for-byte 可 / 要改変

### byte-for-byte コピー可（8 モジュール + 10 テスト）
`scope-dir.ts` / `session-scope.ts` / `resume-priority.ts` / `sdk-stop-reason.ts` /
`path-mutex.ts` / `atomic-write.ts` / `history-compaction.ts` / `plan-file-store.ts` /
`session-store.ts` / `conversation-store.ts`
（後 2 者は Windows 版を Linux 版で丸ごと置換。import は Node 組込みと同一コピーセット内の兄弟のみ）

テスト: `scope-dir` / `session-scope` / `resume-priority` / `path-mutex` / `atomic-write` /
`history-compaction` / `plan-file-store` / `sdk-stop-reason` / `session-store-scope` /
`conversation-store-scope` の 10 本。

### 手編集が必要（2 本のみ）
- `agents/windows/src/services/connection.ts` — logger 差 + `sleep-preventer` + `DEFAULT_ALLOWED_TOOLS_WINDOWS`
- `agents/windows/src/services/ai-runner.ts` — logger 差 + CLI spawn モデル

---

## 6. 方針比較

### Option B「#376 最小移植」
- 追加 2（`scope-dir.ts` / `resume-priority.ts`）+ 修正 4（`session-store.ts` / `conversation-store.ts` / `ai-runner.ts` / `connection.ts`）= **6 ファイル / 約 40 呼び出し箇所**
- 先送り: #348 全部、#375 全部、#377 全部、テスト基盤
- 主リスク: traversal 検証を含む `resolveScopeDir()` を **テストゼロの workspace に手コピー**で投入する

### Option A「Linux 構造に寄せる」【推奨】
- 追加 18（8 モジュール + 10 テスト）+ 修正 5（上記 4 本 + `package.json`）+ 3 OS 横断 JSDoc 1 行 ×6
  = **23 ファイル / 約 70 呼び出し箇所**
- 先送り: §1「対象外」の一覧、および **Claude Agent SDK の採用そのもの**（Windows は CLI spawn のまま）

### 推奨理由
1. Option B の `session-store.ts` + `conversation-store.ts` 作業だけで A の差分の約 9 割。
   A の増分は「小さい純モジュール 6 本 + テストディレクトリ」で、別プロジェクトではない。
2. テストは **verbatim コピーで既に 2 OS で green**。`package.json` 1 行で手に入るものを
   捨てて traversal 検証を無テスト投入するのは割に合わない。
3. Windows は現状、**4 件すべてで単独最悪**: `conversation.json` にロックも atomic write も無い（#348）、
   `get_plan` が 15 秒ハング（#375, F5）、turn 上限 200 で無告知打ち切り（#377, F3）。
   B は 4 件中 1 件だけ直し、残り 3 件を将来のバグ報告として温存する。
4. `scope-dir.ts:20` / `resume-priority.ts:15` は既に windows を名指しで不変条件に含めている。
   この 2 本だけ入れると隣接モジュールが乖離したまま＝今の 43 対 20 を生んだドリフトそのもの。

**反論の明示**: 「今週 Windows 1 台を通したいだけ」なら B（6 ファイル）で足りる。
下記サブサイクル A+B+C は **実質 Option B + テスト**なので、A の道に入っても損はなく、C 時点で停止できる。

---

## 7. #377 の扱い: **(a) subtype 読み取り + `--max-turns` の env ゲート付き配線**

**採用**: CLI stream-json の `result` 行から `subtype` / `is_error` を読み、
`sdk-stop-reason.ts` の byte-identical コピーで `mapResultSubtypeToStopReason()` に通し、
5 番目の引数 `stopReason` としてサーバーへ送る。加えて F1 の隠しフラグで `--max-turns` を配線する。

- **dead code 懸念は F1 で解消**: `resolveSdkMaxTurns()` は Windows でも live になり、
  かつ Windows の上限を 200 → Linux 同等（400 / env 可変）に引き上げられる。
- **(b) を採らない理由**: `stopReason` 未送信 = サーバーが `'success'` を既定採用
  （`apps/server/src/services/stop-reason.ts` の `normalizeStopReason`）。
  F3 のとおり Windows は turn 200 で打ち切られるので、**短い答えが「成功」として報告される** —
  #377 が消そうとした失敗モードそのものが、Linux の半分の閾値で起きる。
- **(a) は (b) を strictly dominate する**: `subtype` が undefined でも
  `mapResultSubtypeToStopReason(undefined, false)` は `sdk-stop-reason.ts:83-85` により
  `{ stopReason: 'success', unknownSubtype: true }` を返す。これはサーバーが今日既に合成している値と
  同一で、**挙動変化ゼロ・誤検知ゼロ**。増えるのはログ 1 行だけ。つまり (a) の最悪ケースが (b)。

### 残存リスク（明記）
唯一ハード失敗し得るのは `--max-turns` の付与。commander は未知オプションを
非ゼロ + 空 stdout で弾き、`classifyCliFailure` → `emptyNonZero` → `ai.cliFailed` になる。
Windows の未知フラグ自動リトライ（`ai-runner.ts:1503-1533`）は `aiTool === 'devin'` 限定で
claude をカバーしない。
→ **`process.env.DEVRELAY_SDK_MAX_TURNS` が明示設定されているときだけ付与**（既定オフ）。
既定経路は今日と完全同一。実機で `max_turns` を 1 度観測してから既定オンを検討する。

### 実装前の計測ステップ（Windows 実機 / read-only / 約 30 秒）
```powershell
cd $env:TEMP
"reply with the single word ok" | claude -p --output-format stream-json --verbose --max-turns 1 2>&1 | Select-String '"type":"result"'
```
| 観測 | 意味 | 対応 |
|---|---|---|
| `"subtype":"error_max_turns"` or `"success"` + `is_error`/`num_turns` | F1/F2 が実機で確認 | サブサイクル D をそのまま実施 |
| stderr に `unknown option '--max-turns'` | 隠しフラグがこの CLI 版に無い | `--max-turns` は入れない。**`subtype` 取得は有効なので D は続行** |
| `result` 行に `subtype` キー無し | 古い/派生 CLI | 上記フェイルセーフで (b) に自動縮退 |

---

## 8. 実装サブサイクル（#368 Phase2a と同じ A〜E 方式）

### サブサイクル A — 純追加（呼び出し元ゼロ・挙動変更ゼロ）
- 8 モジュール + 8 テストを `agents/linux` から verbatim コピー
- `agents/windows/package.json` に `"test": "node --test tests/"`
- `session-scope.ts` / `path-mutex.ts` / `atomic-write.ts` の JSDoc 不変条件 1 行を **3 OS 分**修正
- **ゲート**: `pnpm build` green / windows の `node --test` green / 8 本の `diff` 空 /
  `git diff` に `connection.ts`・`ai-runner.ts` の変更が **ゼロ**

### サブサイクル B — ストア層（既定 `undefined` = 呼び出し側は従来経路）
- **B1（真に中立）**: `session-store.ts` を Linux 版で置換 + 25 呼び出し箇所をコンパイル通し。
  `session-store-scope.test.mjs` を追加
- **B2（#372 の挙動変化を含む）**: `conversation-store.ts` を Linux 版で置換。
  `conversation-store-scope.test.mjs` を追加
- **⚠ R-A1**: Linux の `appendToConversation` / `markExecPoint` は `mutateConversation()`
  （`conversation-store.ts:127-160`, `:243-258`）でディスクから読み直し、**呼び出し側の
  in-memory `history` 引数を捨てる**。Windows は `connection.ts:507/:528` で
  `markExecPoint(projectPath, sessionInfo.history)` を渡し in-memory 配列が返る前提。
  現状は `:612` で毎プロンプト前に save しているため不変条件は成立するが、
  **暗黙前提にせず明示的に検証すること**
- **⚠ R-A2**: `history-compaction.ts` の `stripProgressMarkers()` は `🔧 …を使用中` 行を落とし、
  プラン文脈を直前 exec マーカー以降に限定する。#372 の意図どおりだが **Windows の出力が変わる**
- **ゲート**: 両ストアの `diff` 空 / テスト green / grep で「まだどこも非 `undefined` の
  `agentScopeId` を渡していない」ことを証明（全部 `.devrelay/` 直下に解決）

### サブサイクル C — スコープ配線【**このサイクルだけ挙動が変わる**】← core#336 本体
- `SessionInfo`（`connection.ts:102-110`）に `agentScopeId?`、`sessionInfoMap`（`:111`）の
  3 生成箇所（`:397`, `:523`, `:1232`）でセット
- payload 型 3 本（`:350`, `:490`, `:559`）に `agentScopeId` / `resumeSessionId` / `turnId` を追加
- conversation 呼び出し 14 箇所のうち **7 箇所**（`:369`, `:507`, `:512`, `:528`, `:612`, `:855`, `:943`）
  に scope を渡す（残り 7 は Linux と同じくプロジェクト単位のまま）
- `loadClaudeSessionId`（`:390`）/ `clearClaudeSessionId`（`:879`）に scope
- `isEphemeralSession()` ゲート + `handleSessionEnd` クリーンアップ（Linux `:605`, `:700-702`, `:793`, `:886` の写し）
- `SendPromptOptions.agentScopeId` + `decideResume()` + ai-runner の 17 store 呼び出し
- `OutputCallback` を `ai-runner.ts:388` で 3→5 引数に拡張（**TS の引数少数許容により既存呼び出しは 0 箇所破壊**）。
  ただし `stopReason` はこのサイクルでは未投入
- 完了 payload 2 箇所（`:834-846`, `:923-935`）に `aiSessionId` / `aiTool` / `turnId`
- **⚠ R-B2（引数位置の罠）**: `saveClaudeSessionId(projectPath, sessionId, mode?, agentScopeId?)`。
  Windows `ai-runner.ts:1191` は現在 2 引数。3 引数に「直す」と scope が `mode` に入り
  不正な `claude-session-meta.json` を静かに書く。**Linux（`ai-runner.ts:1275`, `:2407`）と同じく
  `undefined` を明示した 4 引数形を必須とする**
- **⚠ R-B1（一度きりの状態移行）**: `u` 後の初回 MCP submission は
  フラットな `claude-session-id` を resume せず空の `.devrelay/sessions/<id>/` から始まる。意図どおりだが**リリースノートに明記**
- **ゲート**: 同一 Windows プロジェクトへの MCP `submit_instruction` 2 本同時で
  `.devrelay/sessions/<id>/` が 2 つ生成される / `conversation.json` のメッセージ数が退行しない /
  対話経路（WebUI/Discord/Telegram）は従来どおり `.devrelay/` 直下

### サブサイクル D — #377 可視化 + #375 保存側
- **先に §7 の実機計測を実施**
- `ai-runner.ts:1257` — `json.subtype` / `json.is_error` / `json.num_turns` を
  `mapResultSubtypeToStopReason()` に通してクロージャ変数に保持。`!== 'success'` のときログ
- 完了 2 箇所（`:1659` `(No response from AI)`, `:1689` 通常完了）で 5 番目の引数として送出。
  `:1494` の SIGTERM は `'aborted'`
- `ai-runner.ts:572-607` — `process.env.DEVRELAY_SDK_MAX_TURNS` が**明示設定時のみ**
  `'--max-turns', String(resolveSdkMaxTurns(process.env))` を push
- `connection.ts:813` / `:905`（コールバック宣言）→ `:834` / `:923`（payload）へ `stopReason` を伝播
- `connection.ts` — plan ターンで `persistPlanFile()`（Linux `:1392-1397` の写し、
  `savePlanFile` + `stripProgressMarkers`）

### サブサイクル E — #375 読み取り側 + docs + push
- `case 'server:plan:latest'` + `handlePlanLatest()` + `replyPlan()`（Linux `:3007-3075` の移植。
  `os` の `homedir`、`fs/promises` の `readdir`/`stat` を新規 import）
- `doc/changelog.md` / `doc/devlog/` / `rules/project.md` 更新
- `pnpm build` 全 workspace / `node --test` を **workspace ごとに個別実行**（#333 の教訓）
- `diff -q` スイープで共有 10 モジュールが 3 OS で byte 一致であることを証明
- **commit + push は必須**（Windows 機は `u` = `git fetch && git reset --hard origin/main` で更新するため、
  `pnpm build` だけでは絶対に届かない）

---

## 9. 変更対象ファイル（クリティカルパス）

| パス | 役割 |
|---|---|
| `agents/windows/src/services/connection.ts` | 配線の本丸。`SessionInfo`/`sessionInfoMap`（`:102-111`）、payload 型 3 本（`:350`,`:490`,`:559`）、完了 payload 2 本（`:834`,`:923`）、`server:plan:latest` 欠落（dispatcher `:251-347`） |
| `agents/windows/src/services/ai-runner.ts` | `OutputCallback`（`:388`）、CLI 引数組み立て（`:572-607`）、`subtype` を捨てている result 分岐（`:1257-1259`）、完了 2 箇所（`:1659`,`:1689`）、17 store 呼び出し |
| `agents/windows/src/services/session-store.ts` | Linux 版で丸ごと置換（`getSessionPath` `:27-29` がフラット） |
| `agents/windows/src/services/conversation-store.ts` | Linux 版で丸ごと置換（パス解決 `:22-24`,`:56`,`:136`） |
| `agents/windows/package.json` | `"test": "node --test tests/"` 追加 |
| `agents/linux/src/services/{scope-dir,resume-priority,session-scope,path-mutex,atomic-write,sdk-stop-reason,history-compaction,plan-file-store}.ts` | コピー元（**再利用。新規実装しない**） |
| `agents/linux/src/services/connection.ts` | 移植の参照実装（scope 配線 `:605-653`,`:774-867`,`:883-925` / 5 引数 `:1420`,`:1586` / `persistPlanFile` `:1392-1397` / `handlePlanLatest` `:3007-3075`） |
| `agents/{linux,macos}/src/services/{session-scope,path-mutex,atomic-write}.ts` | JSDoc 不変条件 1 行のみ（サブサイクル A） |

**触らない**: `apps/server/`、`packages/shared/`、`prisma/`、`agents/macos/`（JSDoc 1 行を除く）。
→ **server 再起動不要・DB マイグレーション不要**。

---

## 10. 検証

### 各サブサイクル共通（この Linux 機で完結）
```
pnpm build                                   # root -r。agents/windows も含む
pnpm --filter @devrelay/agent-windows test   # サブサイクル A 以降
node --test  # workspace ごとに個別実行（#333: まとめ実行は取りこぼす）
diff -q agents/linux/src/services/X.ts agents/windows/src/services/X.ts   # 共有10本すべて
git diff --stat -- apps/ packages/ prisma/   # 空であること
```

### サブサイクル C の E2E（Windows 実機、要 `u`）
1. 同一 Windows プロジェクトへ MCP `submit_instruction` を 2 本並行投入
2. `<projectPath>\.devrelay\sessions\` に submissionId 別のディレクトリが 2 つできることを確認
3. 対話経路（WebUI）で 1 ターン流し、`<projectPath>\.devrelay\` 直下に従来どおり書かれることを確認
4. `conversation.json` のメッセージ数が両経路で退行しないことを確認

### サブサイクル D の E2E
1. §7 の計測コマンドを先に実行し、`subtype` の有無を実測（**書く前に測る**）
2. `DEVRELAY_SDK_MAX_TURNS=1` を設定して 1 ターンで打ち切らせ、
   チャットに truncation マーク（`buildStatus.truncatedMark`）が出ることを確認
3. env を外し、既定経路が今日と同一（`--max-turns` 不付与・`stopReason='success'`）であることを確認

### サブサイクル E の E2E
Windows マシンのプロジェクトに対し MCP `get_plan` を実行し、
**15 秒ハングせずに**プラン本文が返ることを確認（F5 の解消）。

---

### 訂正（2026-09-09、core#383）

本ドキュメントの背景説明（サブサイクル C の動機付け等）は、Windows マシン（hp630g9）で観測された
MCP `approve_implementation` の fail-closed（`planAiSessionMissing`）を「Windows Agent 移植の遅延
（core#336 の scope 配線が Windows に未反映）」に起因するものと位置づけていたが、これは誤りである。

- hp630g9 は **`agents/windows` ではなく `agents/linux` を node.exe で実行**しており、
  `agents/windows` は未デプロイである。したがって Windows Agent の移植状況は当該事象と無関係。
- 真因は **端末モード（`Project.terminalMode = true`）の PTY 経路が AI セッション ID を
  完了報告にエコーバックしていなかったこと**（`agents/linux/src/services/ai-runner.ts` の
  `onOutput()` 呼び出しが第 4 引数 `extractedSessionId` を渡していなかった）。
  その結果 `Session.planAiSessionId` が NULL となり、`submission-guard.ts` の
  `shouldRecordPlanAiSession()` が false を返し、`approve_implementation` が fail-closed していた。
- この穴は **OS 非依存**で、端末 ON のプロジェクトであれば Linux 機でも同様に再現する
  （実測: 端末 ON プロジェクトで再現、端末 OFF プロジェクトでは発生せず）。
  逆に macOS Agent は PTY 経路自体を持たない（`agents/macos/src/services/ai-runner.ts` に
  「macOS Agent は PTY（terminalMode）経路を持たない」と明記）ため影響を受けない。
- 修正は core#383（`agents/linux` のみ・3 commit）で実施済み。本ドキュメントが記述する
  Windows Agent 移植（core#336 の scope 配線を Windows へ適用する作業）自体は、
  Windows マシンで **MCP submission スコープ分離**（`.devrelay/sessions/<agentScopeId>/`）を
  有効にするための独立した価値のある作業であり、それ自体は誤りではない。誤りは
  「hp630g9 の fail-closed の原因」という**個別事象への紐付け**の部分のみである。
