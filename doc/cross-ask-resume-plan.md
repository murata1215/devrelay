# 案C′: クロス ask のセッション継続（相手の AI が覚えている状態）

> read-only 調査（プランモード）の結果として作成した実装プラン。元調査時点の対象コミット:
> `f2726fe`（main、Phase C 実装済み）。
>
> **実装状況（2026-11-10 追記）**: 本ファイル作成時点では未実装だったが、同日の exec で **C1（Agent 側:
> `packages/shared/src/types.ts` + `agents/{linux,macos,windows}` の `session-scope.ts`/`connection.ts` +
> 新規テスト `session-state-policy.test.mjs`）のみ実装済み**。サーバーが `statePolicy` を一切送らないため
> C1 単体では挙動は完全に不変（resume は未稼働）。**C2（サーバー配線）・C3（WebUI）・G（既存バグ修正）は
> 未実装**。後続サイクルは下記本文の該当セクションをそのまま使ってよい。詳細は
> `doc/devlog/INDEX.md` の該当エントリを参照。
>
> **実装状況（2026-11-10 追記2）**: **G（既存バグ修正一式、`34f5228`）を実装済み**。
> `EphemeralStatePolicy` に第4区分 `'isolated'` を追加し、`decideCrossAskIsolation()` で
> capability + 読み取り専用強制可否を検証して deny-closed にした。G-11（レート制限）は
> C2 送りのまま。詳細は `doc/devlog/2026-11-10_151128.md`。
>
> **実装状況（2026-11-11 追記）**: **C2（サーバー配線、`b47cb0b`）を実装済み**。
> `cross-ask-resume-rules.ts` 新設・`cross-ask-runner.ts`/`agent-manager.ts` 配線・
> `DEVRELAY_CROSS_ASK_RESUME`（既定OFF）/`_TTL_DAYS`（既定14）/`_MAX_TURNS`（既定40）・
> G-11（レート制限）・Agent 側 A-1（`refuseUnsafeAiTool:true`）/A-2（retry の
> `projectStateRead` 引き継ぎ修正）を実装。本文中の「③ resume 失敗時に案Bへ落とす」
> 「④ strictReadonly が毎回効くことの確認」「⑤ 二重注入を避ける」は実装時に型レベルの
> 排他（`mode:'resumable'` ⇒ `includeContextPrefix:false`）で解決し、`decideCrossAskIsolation()`
> の「出力」ではなく「入力」を resume 判定が直接受け取る設計に変更した点が本文の提案と異なる
> （`isolated` という中間状態を経由しない）。**C3（WebUI の「会話をリセット」・旧世代 scope dir
> の明示削除）は未実装**。`document-api.ts`（ask-member REST/スキル経路）は resume 対象外の
> ままという本文の想定どおりの割り切りを維持した。詳細は `doc/devlog/2026-11-11_144009.md`。

## Context（なぜやるか）

Phase C（2026-11-10）で購読/借用プロジェクトを「質問専用タブ」として会話できるようにしたが、
会話の継続は **案B（サーバーが直近3往復をプロンプトに前置、最大 6,000 文字）** で代替した。
宛先の AI 自体は毎回ゼロから読み直すため、往復が増えるほど無駄にトークンを食い、長い文脈は切れる。

本物の resume（案C）は「`crossask_` プレフィックスを足して Agent 側 `classifySessionScope()` に
`interactive` と判定させる」方法を採りかけて**自己レビューで撤回**した。`interactive` 扱いが
`clearOutputDir()`（所有者の `.devrelay-output/` を質問のたびに `rm -rf`）・`savePlanFile()`
（`.devrelay/plans/` の増殖）・work state の消費まで同時に有効化し、#348 の事故を再発させるため。

**本サイクル（案C′）の目的**: 「会話の継続だけを許可し、それ以外の projectPath 上の副作用は
一切許可しない」第3の区分を作り、未更新 Agent では黙って案Bに縮退させる。

---

# 調査結果

## 1. 既に土台がある — `agentScopeId` / scope dir

`core#336` 〜 スレッド管理 cycle1/2 で、会話状態をプロジェクト単位から**スコープ単位**へ
分離する仕組みが完成している。**案C′ に必要な部品はほぼ全部揃っている。**

| 仕組み | 場所 |
|---|---|
| `resolveScopeDir(projectPath, agentScopeId)` → `<projectPath>/.devrelay/sessions/<id>/` | `agents/{linux,macos,windows}/src/services/scope-dir.ts:52`（3 OS byte-identical） |
| `isValidAgentScopeId()`（`^[A-Za-z0-9_-]{1,128}$` + resolve 後の配下検証） | 同 `:34` |
| `conversation.json` が scope 対応 | `conversation-store.ts:42,65,169,195`（全関数 `agentScopeId?`、`withPathLock` 付き） |
| `claude-session-id` / `codex-session-id` / `devin-*` / `context-usage` が scope 対応 | `session-store.ts:45,72,101,115,151,…,511` |
| wire フィールド | `packages/shared/src/types.ts:798`（`AiPromptPayload.agentScopeId`）、`:371`（`SessionStartPayload`） |
| `startSession()` / `sendPromptToAgent()` が既に `agentScopeId` を運べる | `apps/server/src/services/agent-manager.ts:1424-1437` / `1445-1471`（`scopeOptions`） |
| `Session.agentScopeId` 列が既に存在（**DB 変更不要**） | `apps/server/prisma/schema.prisma:375` |
| scope 単位クリアの Agent 実装（`clearOutputDir` は呼ばない） | `connection.ts:1089` `handleConversationClear` |
| capability ゲートの前例（純関数 + fail-closed） | `services/thread-clear-guard.ts` + `command-handler.ts:896-907` |
| **先行実装**: MCP `ask_project` は既に `agentScopeId = sessionId` + `strictReadonly` で動いている | `apps/server/src/mcp/tools.ts:1329,1366-1380` |

**決定的な事実**: `persistProjectState` で守られている Claude 経路の書き込みは**すべて scope dir 対応済み**
（`ai-runner.ts:1360,1394,1453,1584,2931,2942`）。一方
`savePlanFile` / `clearOutputDir` / `loadWorkState` / `archiveWorkState` / `loadStorageContext` /
`collectOutputFiles` は **projectPath 直下専用で scope の概念を持たない**
（`plan-file-store.ts:13,25` は `resolveScopeDir()` を通さない）。
この境界がそのまま「許可してよいもの / 絶対に許可しないもの」の線になる。

## 2. 設計の転換点 — `crossask_` プレフィックスは**作らない**

撤回前案は新プレフィックスを足す前提だった。これを捨て、
**`crossquery_` を維持し、resume 可否を wire の新フィールドで明示する**方式に変える。

| 観点 | `crossask_` 新設（撤回前案） | `crossquery_` 維持（本案） |
|---|---|---|
| 未更新 Agent に届いた場合 | `classifySessionScope()` が未知プレフィックスを `interactive` と判定 → **#348 事故が再発**。安全性がサーバーの capability チェック 1 枚に依存 | `isEphemeral=true` のまま → 読み書きゼロ。**構造的に事故れない**（未知フィールドを無視するだけ） |
| ナレッジ汚染 | `knowledge-service.ts:186` の `isEphemeralSessionId()` を通らなくなり、**依頼者の質問が所有者の `KnowledgeChunk` として embedding される** | 従来どおり除外。変更不要 |
| レート制限 | `countRecentCrossSessions('crossquery_', …)`（`cross-session-stats.ts:18`, `document-api.ts:705,712`）が壊れる | そのまま有効 |
| 同時実行ガード | `findInflightCrossQueryRows()`（`cross-session-stats.ts:49`）が効かない | そのまま有効 |
| スレッド一覧除外 / 起動時スイープ / 履歴 API | `thread-scope.ts:24`、`index.ts:136`、`thread-scope.ts:73` に追加が必要 | 全て不要 |
| 既存テストのピン | `tests/cross-team-chat-wiring.test.mjs:128-130`（`assert.doesNotMatch(source, /`crossask_/)`）を**意図的に外す**必要がある | **ピンはそのまま green**（撤回案の復活防止ガードを生かしたまま resume を入れられる） |

加えて、**「安定セッション = 長命な Session 行」も作らない**。Session 行は従来どおり
1 ターン 1 行の `crossquery_<uuid>`（作成 → `ended`）のままにし、
**安定性は Agent の scope dir（ファイル）だけに持たせる**。これにより撤回前案で問題になっていた
以下が**すべて不要**になる:

| 撤回前案の課題（調査で確認） | 本案での扱い |
|---|---|
| `status:'active'` が常態化し `findInflightCrossQueryRows()` が常に busy を返す（`cross-ask-runner.ts:90-112`） | **不要**（1 ターン 1 行のままなので既存ガードがそのまま効く） |
| `countRecentCrossSessions()` の 5 分窓 count が無効化（`cross-session-stats.ts:23-39`） | **不要**（数え方は不変） |
| 監査 `request`/`completed`/`failed` の sessionId 1:1 対応が崩れる（`cross-ask-runner.ts:128,203,218`） | **不要**（1:1 を維持） |
| 起動時スイープ `index.ts:136` が安定セッションを `ended` にしてしまう | **不要** |
| `GET /api/threads` / `handleProjectConnect` に安定セッションが漏れる | **不要** |
| `Session.kind='crossAsk'` 等の DB 列追加 | **不要**（`agentScopeId` 既存列に入れるだけ） |
| `touchSessionActivity` の skip 見直し（`session-manager.ts:340`） | **不要** |

**撤回前案から流用するのは「決定論的 id」「`agentScopeId`」の 2 つだけ。**
「ペア単位ロック」は既存の宛先プロジェクト単位 inflight ガードが上位互換なので不要
（ただし §G-5 の補強は推奨）。

## 3. Agent 側の書き込み全数表（`agents/linux`、`f2726fe`）

### 3-a. `isEphemeral` を見て**スキップされる**処理（= 現在 crossquery で既に安全）

| file:line | 関数 | 操作 | 置き場所 |
|---|---|---|---|
| `connection.ts:959` | `handleSessionStart` | `loadConversation()` read | scope dir |
| `connection.ts:968` | `handleSessionStart` | `loadWorkState()` read（G-2 で修正済） | **projectPath 直下** |
| `connection.ts:987` | `handleSessionStart` | `loadClaudeSessionId()` read | scope dir |
| `connection.ts:1177,1184,1200` | `handleConversationExec` | 履歴 read / `markExecPoint` write | scope dir |
| `connection.ts:1277,1278` | `handleAiPrompt`（auto-init） | 履歴 + session id read | scope dir |
| `connection.ts:1363-1365` | `handleAiPrompt` | `saveConversation()` write | scope dir |
| `connection.ts:1370-1372` | `handleAiPrompt` | **`clearOutputDir()`**: `.devrelay-output/` を archive→`rm -rf`→mkdir（`output-collector.ts:48-58,64-93`） | **projectPath 直下** |
| `connection.ts:1636` | `handleAiPrompt` | `persistProjectState: !isEphemeral` を ai-runner へ | — |
| `connection.ts:1769-1771,1879,2013` | `persistPlanFile` | **`savePlanFile()`**: `.devrelay/plans/YYYYMMDD-HHmmss.md` write + 20件超を `unlink`（`plan-file-store.ts:67,75,84`） | **projectPath 直下（scope 非対応）** |
| `connection.ts:1888-1891,2020-2023` | 完了/retry | `saveConversation()` write | scope dir |
| `connection.ts:1922-1924` | resumeFailed | `clearClaudeSessionId()` delete | scope dir |
| `ai-runner.ts:1360,1394` | loop-guard / auto-compact | `clearClaudeSessionId()` delete | scope dir |
| `ai-runner.ts:1453,2931` | SDK / spawn | `saveClaudeSessionId()` write | scope dir |
| `ai-runner.ts:1584,2942` | SDK / spawn | `saveContextUsage()` write | scope dir |

### 3-b. `isEphemeral` / `persistProjectState` を**見ずに無条件で走る**処理（網羅）

**projectPath 直下・共有領域への書き込み**

| file:line | 操作 | 実行条件 | 評価 |
|---|---|---|---|
| `connection.ts:1337` → `file-handler.ts:73,121` | `<projectPath>/.devrelay-files/<ts>_<name>` mkdir + write | `files?.length>0` のみ | cross ask は `files` を送らないため現状到達しない（`web:cross:ask` に `files` なし、`executeCrossProjectQuery` は `undefined`）。**ガードは一段も無い** |
| `connection.ts:1391` → `work-state-store.ts:91,97` | `work_state.json` を `work-states/` へ **rename（所有者の auto-continue を消費）** | `pendingWorkState != null` のみ | G-2 で `:968` が null を返すようになり到達しないが、**二重防御なし** |
| `connection.ts:1897,2028` → `projects.ts:359`, `config.ts:225` | `rescanProjectsAndSync()`: 発見した各ディレクトリに **`CLAUDE.md` を writeFile**、`~/.devrelay/projects.yaml` を writeFile | **`isExecTriggered` のみ**（`:1896`） | 現状は cross ask で exec にならないので到達しない。**resume で履歴に `exec` が混ざると到達する** → §④の `forcePlanTurn` が必要な第 2 の理由 |
| `connection.ts:2087-2099` → `git-guard.ts:101-105,122` | 未追跡ファイルを `.devrelay/reverted/<ISO>/` へ **rename**、追跡ファイルを **`git checkout`/`reset` で上書き復元** | `isDevin && isPlanTurn`（`:1775`） | **既存の重大事故経路**: Devin プロジェクトへのクロス ask は所有者の作業ツリーを巻き戻しうる。→ Devin は resumable 対象外にする（§③）+ G 項目 |
| `connection.ts:1655,1673,1691` → `approval-logger.ts:60,63` | `~/.devrelay/approvals/current.jsonl` に append | 無条件（deny のみ `strictReadonly` 時） | 機体グローバル・監査用途なので許容 |
| `connection.ts:942` | `resetApproveAllMode()`（プロセス全体の「以降すべて許可」解除） | 無条件 | **既存バグ**: 他人の ask が所有者の承認モードを解除する |

**scope dir 内だが `persistProjectState` を見ていない（= 現在 cross ask は `agentScopeId` 未指定なので `.devrelay/` 直下 = 所有者の対話セッションを直撃する）**

| file:line | 操作 | 評価 |
|---|---|---|
| `ai-runner.ts:2856-2858` | `saveCodexSessionId()` write | **既存バグ（実害あり）**: Codex プロジェクトへのクロス ask が所有者の `codex-session-id` を上書き |
| `ai-runner.ts:3263,3266,3268,3269,3287,3297,3301,3303` | `saveDevinSessionId` / `Model` / `AtifStepOffset` / `PermissionMode` write | 同上（Devin 4 ファイル） |
| `ai-runner.ts:3514` | 上記 4 ファイルを **delete** | 同上 |
| `ai-runner.ts:3524` | `clearCodexSessionId()` **delete** | 同上 |
| `terminal-runner.ts:451,1265` | `saveClaudeSessionId()` write（`promptSent` のみで判定） | **既存バグ**: terminalMode プロジェクトへのクロス ask が所有者の `claude-session-id` を上書き |
| `ai-runner.ts:3275-3284` → `session-store.ts:230` | `.devrelay/sessions/*/devin-session-id` を**全スコープ横断 readdir** | read のみ |

**read のみ（情報漏れ）**

| file:line | 操作 | 評価 |
|---|---|---|
| `connection.ts:1397` | `loadStorageContext()` の内容を**プロンプトに注入** | **既存バグ（クロスユーザー情報漏れ）** |
| `connection.ts:1844,1985` | `collectOutputFiles()` → **依頼者へ添付送信** | **既存バグ（クロスユーザー情報漏れ）**: 所有者が書きかけの成果物が借り手に届く |
| `connection.ts:974,979` | `getAgreementStatusType()` / `loadStorageContext()` 存在確認 | 無害 |
| `connection.ts:1542` | `~/.claude/projects/<slug>/memory/MEMORY.md` stat | 無害 |
| `connection.ts:1468` 付近 | `OUTPUT_DIR_INSTRUCTION` を常に付与 | 所有者プロジェクトへの書き込みを AI に勧める文言。ask では不要 |

**その他（機体・/tmp）**

| file:line | 操作 | 評価 |
|---|---|---|
| `ai-runner.ts:2447-2448` | `/tmp/devrelay-prompt-<sid>.txt` に**プロンプト全文を平文 writeFileSync（0644）**。`:3230-3234` は失敗ターンでは **削除しない** | **既存の情報露出**: 借り手の質問文（+文脈前置）が所有者機の /tmp に残る |
| `terminal-runner.ts:320-324` | `~/.devrelay/logs/terminal-<sid>.log` に PTY 全出力を append | 機体ローカル |
| `ai-runner.ts:2069` → `capability-sync.ts:314` | `reconcileForRunner()`（`!rawMode` のみ）。plugin install で `~/.claude/` を書換えうる | TTL キャッシュで抑制 |
| `ai-runner.ts:3863-3868` | `~/.devrelay/bin/devrelay-claude` wrapper 作成 | 初回のみ |

---

# 実装プラン

## 設計の核: 第3区分を「プレフィックスではなく明示フィールド」で表す

### (a) 共通型（`packages/shared/src/types.ts`）

```ts
/** 一時セッションの状態ポリシー。未指定 = 従来挙動（完全な使い捨て）。 */
export type EphemeralStatePolicy = 'resumable-scoped';
```

- `SessionStartPayload`（`:371`）と `AiPromptPayload`（`:776`）に
  `statePolicy?: EphemeralStatePolicy` を追加（optional ＝ 未更新 Agent は無視するだけ）
- `AgentCapability`（`:35`）と `AGENT_CAPABILITIES`（`:38`）に `'cross-ask-resume'` を追加

> ⚠️ **`AGENT_CAPABILITIES` は Agent 3 機種が中身を見ずに丸投げで申告する**
> （linux `connection.ts:336` / macos `:298` は `[...AGENT_CAPABILITIES]`、windows `:197` は
> `raw-completion` だけ除外）。**実装と同一コミットでなければ絶対に追加しないこと**
> （macos/windows が `capability-sync` を実装せずに申告している既存の過剰申告と同じ事故になる）。

### (b) 分類関数（Agent、**許可リスト方式**）

`session-scope.ts`（外部 import ゼロ規約）に追加する。
**`SessionScope` 型と既存 3 関数は一切変更しない**（`crossQuery` のまま、byte-for-byte 同一維持）。
状態ポリシーを**別の軸**として足す:

```ts
export interface SessionStatePolicy {
  scopedConversation: boolean; // conversation.json / claude-session-id / context-usage（scope dir 内のみ）
  outputDirClear: boolean;     // clearOutputDir()
  outputFileCollect: boolean;  // collectOutputFiles()
  planFile: boolean;           // savePlanFile()
  workState: boolean;          // loadWorkState() / archiveWorkState()
  storageContext: boolean;     // loadStorageContext() のプロンプト注入
  receivedFiles: boolean;      // saveReceivedFiles()
  projectRescan: boolean;      // rescanProjectsAndSync()（CLAUDE.md / projects.yaml 書込）
  forcePlanTurn: boolean;      // 履歴に 'exec' があっても plan ターンに固定
}

export function resolveSessionStatePolicy(
  sessionId: string,
  opts: { statePolicy?: string; agentScopeId?: string },
): SessionStatePolicy
```

判定（**既定は全部 deny。許可は明示的に 1 個ずつ**）:

1. `classifySessionScope(sessionId) === 'interactive'`
   → 全 `true` / `forcePlanTurn=false`（**既存挙動と完全一致**）
2. `opts.statePolicy === 'resumable-scoped'` **かつ** `classifySessionScope() === 'crossQuery'`
   **かつ** `isValidAgentScopeId(opts.agentScopeId)`
   → `scopedConversation=true` / `forcePlanTurn=true` / **他は全部 false**
3. それ以外（現行の全一時セッション）
   → `outputFileCollect` / `storageContext` / `receivedFiles` / `workState` / `projectRescan` は
   **現状どおり true**（挙動不変）、`scopedConversation`/`outputDirClear`/`planFile` は false

`agentScopeId` が不正・未指定なら②に落ちない（③へ）＝
**`<projectPath>/.devrelay/` 直下を resumable 扱いで触ることが構造的に起き得ない。**
これが本サイクルの最重要不変条件。

> ③ で既存バグ（storageContext 注入・outputFileCollect 漏れ・rescan・resetApproveAllMode）を
> そのまま残すのは、差分を「resume を足す」ことだけに絞るため。既存バグは **G サイクル**に分離。

### (c) 各ガードの差し替え（Agent、3 OS 同一内容）

`sessionInfoMap` の型（`connection.ts:249` 付近）に `statePolicy?: string` を追加し、
`handleAiPrompt` は `payload.statePolicy ?? sessionInfo.statePolicy` で解決
（`server:session:start` と `server:ai:prompt` の両方に載せるが片方欠落でも整合させる）。

| 現在 | 変更後 | linux の対象行 |
|---|---|---|
| `isEphemeral ? [] : loadConversation(...)` / `loadClaudeSessionId` | `policy.scopedConversation` | `959,987,1277,1278` |
| `if (!isEphemeral) saveConversation(...)` | `policy.scopedConversation` | `1363,1888,2020` |
| `if (!isEphemeral) clearOutputDir(...)` | `policy.outputDirClear` | `1370` |
| `if (!isPlanTurn \|\| isEphemeral) return` | `if (!isPlanTurn \|\| !policy.planFile) return` | `1769` |
| `isEphemeral ? null : loadWorkState(...)` | `policy.workState ? … : null` | `968` |
| `persistProjectState: !isEphemeral` | `persistProjectState: policy.scopedConversation` | `1636` |
| `const isPlanTurn = !isExecTriggered` | `policy.forcePlanTurn ? true : !isExecTriggered` | `1374-1378` |
| （新規）`loadConversation` 直後 | `policy.forcePlanTurn` なら `role==='exec'` のエントリを捨てる | `959,1277` |
| `if (isExecTriggered) rescanProjectsAndSync()` | `&& policy.projectRescan` | `1896,2027` |
| `if (!isEphemeral) clearClaudeSessionId(...)` | `policy.scopedConversation` | `1922` |

`handleConversationExec`（`1157`〜）は**触らない**（cross ask は `server:conversation:exec` を
送らないため、exec 経路に resumable の概念を持ち込まない）。

### (d) capability ゲート（サーバー）

既存の `scoped-clear` と同型。**`agentHasCapability()` は無改造で流用**。

- 記録: `agent-manager.ts:560`、参照: `agent-manager.ts:1572`（未接続は false）
- 新規純関数 `apps/server/src/services/cross-ask-resume-rules.ts`
  （外部 import ゼロ、`thread-clear-guard.ts` / `cross-query-guard.ts` が形の見本）

```ts
/** 決定論的 scope id。sha256 は呼び出し側で計算し、本関数は整形と検証だけを行う（import ゼロ維持） */
export function buildCrossAskScopeId(digestHex: string): string
// → `crossask-${digestHex.slice(0,32)}`（isValidAgentScopeId を必ず満たす。
//    digest は sha256(requesterUserId + '\0' + projectId) ＝ 所有者の FS に PII を残さない）

export function decideCrossAskSessionPlan(input: {
  isCrossUser: boolean;
  resumeFeatureEnabled: boolean;  // DEVRELAY_CROSS_ASK_RESUME
  agentSupportsResume: boolean;   // agentHasCapability(machineId, 'cross-ask-resume')
  targetTerminalMode: boolean;    // Project.terminalMode → resume 対象外
  targetAiTool: string;           // 'devin' → resume 対象外
  scopeId: string | null;
}):
  | { mode: 'resumable';     agentScopeId: string;    statePolicy: 'resumable-scoped'; includeContextPrefix: false }
  | { mode: 'contextPrefix'; agentScopeId: undefined; statePolicy: undefined;          includeContextPrefix: true }
```

**二重注入の回避を型で担保する**（`mode:'resumable'` では `includeContextPrefix` が `false`
リテラルしか取れない）。単体テストで両立不可を固定する。

### (e) サーバー配線（`cross-ask-runner.ts`、変更は小さく閉じる）

既存の 7 ステップ順序（長さ検証 → 同時実行ガード → Session 作成 → 質問保存 → 文脈前置 → 実行 →
ended+監査）を**崩さず**、以下を差し込む:

1. ステップ2の直後に `decideCrossAskSessionPlan()` を呼ぶ（**いかなる DB 書き込みより前**）
2. ステップ3の `prisma.session.create`（`:116`）に `agentScopeId: plan.agentScopeId ?? null` を追加
   （既存列。`crossquery_` 行なのでスレッド一覧には出ない。監査・SQL 検証に使える）
3. ステップ5（`:160-162`）の条件に `&& plan.includeContextPrefix` を足す
4. ステップ6の `executeCrossProjectQuery(...)`（`:187`）に `scopeOptions` 相当を 1 引数追加
   → 内部の `startSession()`（`agent-manager.ts:1625`、第 6 引数が既に `agentScopeId`）と
   `sendPromptToAgent()`（`:1630`、第 13 引数 `scopeOptions` が既にある）へ流す。
   `sendPromptToAgent` の `scopeOptions`（`:1470`）に `statePolicy?` を 1 フィールド追加し、
   送信 payload（`:1547-1560`）に載せる
5. `targetProject` に `terminalMode` を追加（`cross-team-authz.ts:342-345` の select に 1 行、
   `CrossAskTargetProject` 型（`:35-42`）に 1 フィールド）
6. **`resumeSessionId` は送らない**（Agent 側 `resume-priority.ts:47-52` の `decideResume()` が
   stored（scope dir の `claude-session-id`）を拾うので、サーバーが状態を持つ必要がない）

`permissionPolicy` は従来どおり `resolvePermissionPolicy('ask')` = `strictReadonly`
（`agent-manager.ts:1642` → `permission-policy.ts:42`）。**ターン単位で毎回明示送信される**ため
resume でも必ず効く（§④で二段防御を追加）。

### (f) 会話リセット / 失効時のクリア

`server:conversation:clear` + `agentScopeId` は Agent 側に実装済み（`connection.ts:1089`、
clear 対象は conversation + 各種 session id の 7 ファイルのみで **`clearOutputDir` は呼ばない**）。
したがって **Agent 側の新規実装は不要**、`scoped-clear` capability を見て送るだけ。

- WebUI クロスタブに「この会話をリセット」→ 新 WS フレーム `web:cross:reset`
  （`platforms/web.ts`。認可は `findCrossTeamAskProjectById()` を再利用）
- 購読解除 / grant 取消で best-effort 送信（`routes/api.ts`）+ `CrossTeamAuditLog` に記録
- TTL（最終ターンから N 日超）なら ask 直前にクリアして作り直す

## サイクル分割

| # | 範囲 | 内容 | 反映 |
|---|---|---|---|
| **C1** | shared + Agent 3 OS | `EphemeralStatePolicy` / `'cross-ask-resume'` / `resolveSessionStatePolicy()` / `connection.ts` のガード差し替え。**サーバーが誰も `statePolicy` を送らないので挙動は完全に不変**（単独でマージ・配布可能） | 貸す側マシンの `u` |
| **C2** | サーバー | `cross-ask-resume-rules.ts` 新設 + `cross-ask-runner.ts` 配線 + `agent-manager.ts` 引数追加 + キルスイッチ + §G-5 のレート制限追加。ここで初めて resume が効く | `pm2 restart devrelay-server` |
| **C3** | WebUI + サーバー | 「会話をリセット」（`web:cross:reset`）、クロスタブに「この相手は会話を記憶しています/していません（旧 Agent）」表示、購読解除・grant 取消との連動 | 両方 |
| **G**（独立・任意） | Agent 3 OS | 既存バグ 7 件（下記）。`DEVRELAY_CROSS_ASK_ISOLATION` で囲む | `u` |

C1 → C2 の順を守る。逆順でも**未更新 Agent は未知フィールドを無視して従来の完全使い捨て動作**を
するため事故にはならず degrade のみ（ここが `crossask_` 案との決定的な差）。

## 変更ファイル一覧

**C1**
- `packages/shared/src/types.ts`（`EphemeralStatePolicy`、`AgentCapability` 2 行、
  `SessionStartPayload`/`AiPromptPayload` に `statePolicy?`）
- `agents/{linux,macos,windows}/src/services/session-scope.ts`
  （`SessionStatePolicy` + `resolveSessionStatePolicy()` を追加。既存 3 関数は無変更）
- `agents/{linux,macos,windows}/src/services/connection.ts`（上表のガード差し替え）
- `agents/{linux,macos,windows}/tests/session-state-policy.test.mjs`（新規）

**C2**
- 新規 `apps/server/src/services/cross-ask-resume-rules.ts`
- `apps/server/src/services/cross-ask-runner.ts`（6 箇所）
- `apps/server/src/services/agent-manager.ts`（`executeCrossProjectQuery` / `sendPromptToAgent` の
  オプション束 / `startSession` 呼び出し）
- `apps/server/src/services/cross-team-authz.ts`（select に `terminalMode`）
- `apps/server/src/services/cross-team-guard.ts`（`isCrossAskResumeEnabled()`）
- 新規 `apps/server/tests/{cross-ask-resume-rules,cross-ask-resume-wiring}.test.mjs`
- `CLAUDE.md`（env 表）、`rules/project.md`、`doc/changelog.md`、`doc/devlog/`（+ `INDEX.md`）

**C3**
- `apps/server/src/platforms/web.ts`（`web:cross:reset`）、`routes/api.ts`（取消連動）
- `apps/web/src/{lib/cross-ask-rules.ts,lib/api.ts,hooks/useWebSocket.ts,pages/ChatPage.tsx}`
- `packages/shared/src/types.ts`（`WebClientMessage` に `web:cross:reset`）

## テストでの固定（静的ガード）

Phase C の `cross-team-chat-wiring.test.mjs` 方式（ソース静的ガード）を踏襲する。

1. `tests/cross-team-chat-wiring.test.mjs:128-130` の既存ピン
   （`crossquery_` 採番の維持・`` /`crossask_/ `` 不出現）を**そのまま green に保つ**
   — scope dir 名は `crossask-`（ハイフン）なので当該正規表現には一致しない。
   新たに「scope id は `crossask-` で始まり `isValidAgentScopeId` を満たす」ピンを追加
2. `thread-scope.ts` の `EPHEMERAL_SESSION_ID_PREFIXES`（`:24`）と
   `buildCrossAskSessionIdFilter()`（`:72-74`）が**変わっていない**こと（本案の前提）
3. `resolveSessionStatePolicy()` が `scopedConversation=true` を返すのは
   **3 条件 AND のときだけ**（`statePolicy` × `scope` × `agentScopeId` 妥当性の総当たり表で固定）
4. `planFile` / `outputDirClear` / `workState` / `projectRescan` が resumable で
   **絶対に true にならない**こと
5. `forcePlanTurn=true` のとき `isPlanTurn` が履歴の `exec` マーカーに影響されないこと
6. `connection.ts` 内の `clearOutputDir(` / `savePlanFile(` / `archiveWorkState(` /
   `rescanProjectsAndSync(` の出現箇所数が既知の数から増減していないこと（3 OS 分）
7. `decideCrossAskSessionPlan()` が `mode==='resumable'` のとき
   `includeContextPrefix===false`（二重注入の禁止）、`targetAiTool==='devin'` /
   `targetTerminalMode===true` で必ず `contextPrefix` に落ちること
8. `knowledge-service.ts:186` の `isEphemeralSessionId()` ガードが残っていること

## キルスイッチ

| 変数 | 既定 | 効果 |
|---|---|---|
| `DEVRELAY_CROSS_ASK_RESUME` | **`0`（OFF）** | `1` で初めて resume を使う。OFF なら `statePolicy` を一切送らず現行の案B と完全同一。`DEVRELAY_CROSS_TEAM` / `DEVRELAY_CROSS_TEAM_CHAT` との AND |
| `DEVRELAY_CROSS_TEAM_CHAT_CONTEXT` | `1`（既存） | 案B の前置。resume が効いたターンでは参照されない |
| `DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS` | `14` | 最終ターンからこの日数を超えたら ask 前に scope をクリアして作り直す（`0` で無効） |
| `DEVRELAY_CROSS_ASK_ISOLATION` | `1`（G 導入時） | 既存バグ修正を切る逆キルスイッチ |

新機能の既定 OFF は `DEVRELAY_CROSS_TEAM` の前例に合わせる（新しい信頼境界を黙って開けない）。

---

# 未決事項への提案

**① 会話リセットの導線 / 文脈肥大 / 所有者のトークン消費**
- WebUI クロスタブに「この会話をリセット」（C3）。実体は既存の scoped `x`
  （`server:conversation:clear` + `agentScopeId`、`scoped-clear` capability 必須）
- TTL（`DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS`）で古い scope を自動作り直し
- 上限ターン数（例 30 往復）で強制リセット + 「文脈が長くなったのでリセットしました」の 1 行通知。
  判定材料は scope dir の `context-usage.json`（`session-store.ts:511` が書く）
- **課金は所有者負担のまま**（`executorUserId` でモデル/キー/言語を解決する設計は
  `rules/project.md` の最重要不変条件。変えない）。肥大抑制は上の 3 つで対処
- 副産物: resume が効くターンでは案Bの過去ログ全件 `findMany`
  （`cross-ask-runner.ts:163-173`、`take` なし・`requestedByUserId` に index なし）が走らなくなる
  ＝ サーバー負荷も下がる

**② 購読解除 / grant 取消時の扱い**
- 認可は従来どおり `CrossTeamGrant` / `TeamSubscription` のみ（resume の有無は認可に無関係）。
  取消後は `findCrossTeamAskProjectById()` が null → ask が届かないので、
  scope dir が残っていても**読まれない**
- 取消時に best-effort で scoped clear を送る（オフラインなら送らない。再送キューは作らない
  ＝ DB 変更を増やさない）。送信結果は `CrossTeamAuditLog` の
  `action:'grant_revoked'` / `'subscription_revoked'` の `detail` に残す
- 依頼者側の過去ログ（`GET /api/cross-team/projects/:id/messages`、`api.ts:3506-3508` の
  `requestedByUserId === userId` 1 条件）は Phase C の設計どおり取消後も読める。ここは変えない

**③ resume 失敗時に案Bへ落とす**
- Claude（SDK/CLI）は**既に対処済み**: resume 失敗 → `ai-runner.ts` の retry-without-resume が
  `composeFullPrompt(true)` で scope dir の `conversation.json` をプロンプトに再注入する
  （`connection.ts:1934` は `strictReadonly` も引き継ぐ）。`sessionDiscarded` で
  `clearClaudeSessionId(scope)` が走り次回はクリーンスタート。**サーバー側の追加実装は不要**
- 非 Claude（gemini/codex）は `needsHistoryInPrompt` が常に true なので scope dir の履歴が
  そのままプロンプトに載る ＝ resume 概念なしで継続できる
- **Devin は resumable 対象外にする**: `usePlanMode=false` 固定で `strictReadonly` が効かず、
  さらに plan ターンで `git-guard` の `restoreToBaseline()`（`connection.ts:2087`）が
  所有者の作業ツリーを巻き戻す経路があるため
- **terminalMode プロジェクトも resumable 対象外にする**: `terminal-runner.ts:451,1265` の
  `saveClaudeSessionId()` が `persistProjectState` を見ておらず、PTY + `--resume` を
  クロスユーザーで検証していないため。本サイクルでは案Bに固定
- 「resume できたか」を UI に出すなら完了報告の `aiSessionId` の有無で判定（C3 の表示に使う）

**④ resume したターンでも strictReadonly が毎回効くことの確認**
- `permissionPolicy` は**セッション単位ではなくターン単位**で送られる
  （`executeCrossProjectQuery` → `sendPromptToAgent(..., resolvePermissionPolicy('ask'))`、
  `agent-manager.ts:1642`）。resume しても毎回 `strictReadonly` が届く
- ただし Agent 側は
  `strictReadonly = permissionPolicy==='strictReadonly' && usePlanMode`（`connection.ts:1603`）、
  `usePlanMode = isPlanTurn && !isDevin`、`isPlanTurn = !isExecTriggered`、
  `isExecTriggered` = **履歴の最後が `role:'exec'` かどうか**（`connection.ts:1374-1378`）。
  **resume で履歴を読むようになるため、scope dir の `conversation.json` に `exec` マーカーが
  1 つでも入れば exec モードに転ぶ**（strictReadonly が外れ、`canUseTool` 承認カードが
  所有者に飛び、さらに `rescanProjectsAndSync()` が所有者の `CLAUDE.md` を書き換える）
- 現実には `markExecPoint()` は `handleConversationExec` からしか呼ばれず cross ask は
  `server:conversation:exec` を送らないので到達しないが、**防御が一段しかない**
- → **対策（二段防御）**: ① `policy.forcePlanTurn` で `isPlanTurn` を常に true に固定、
  ② `loadConversation()` 直後に `role==='exec'` のエントリを捨てる（resumable のときだけ）。
  さらに ③ Devin を resumable 対象外にすることで `!isDevin` の前提も崩れない

**⑤ 案Bの前置と resume の二重注入を避ける**
- `decideCrossAskSessionPlan()` の戻り値型で排他にする（`mode:'resumable'` のとき
  `includeContextPrefix: false` リテラル）。`cross-ask-runner.ts:162` の条件に 1 項足すだけ
- Claude SDK 側でも `needsHistoryInPrompt` が `claudeResumeSessionId` の有無で切れるため、
  resume 成功時はプロンプトに履歴が載らない（既存ロジックのまま）
- `OUTPUT_DIR_INSTRUCTION` は resumable では付けない（所有者プロジェクトへの書き込みを
  AI に勧める文言。`strictReadonly` で deny されるが毎ターン無駄な deny ログを出すだけ損）

---

# 既存バグ（G サイクル。resume とは独立。いずれも「貸す側マシンの `u`」で反映）

調査で見つかった、**現行のクロスユーザー ask で既に起きているもの**。
案C′ は resumable 経路でこれらを全て deny にするので**悪化はさせない**が、
非 resumable 経路（旧 Agent / Devin / terminalMode / 同一ユーザー ask）では残る。

> **2026-11-10 サイクルG で G-3/G-4/G-5/G-6/G-7/G-8/G-9/G-12 を実施済み**
> （`doc/devlog/2026-11-10_151128.md`）。G-10/G-11 は対象外のまま（下表参照）。
> 実施版の設計は `rules/project.md` の「G サイクル（既存バグ修正一式、2026-11-10）」節、
> wire 設計は `EphemeralStatePolicy='isolated'`（本ドキュメントの `'resumable-scoped'` とは
> 別の第4区分。resume は未配線のまま）。

| # | 内容 | 場所 | 深刻度 | 状態 |
|---|---|---|---|---|
| G-3 | 所有者の `storage-context.md` が借り手向けプロンプトに注入される | `connection.ts:1397` | 情報漏れ | ✅ 実施済み（`statePolicy.storageContext` でガード、isolated のみ deny） |
| G-4 | 所有者の `.devrelay-output/` の中身が借り手へ添付転送される | `connection.ts:1844,1985` | 情報漏れ | ✅ 実施済み（`statePolicy.outputFileCollect` でガード） |
| G-5 | **Codex / Devin のセッション ID 永続化が `persistProjectState` を見ていない** → クロス ask が所有者の `codex-session-id` / `devin-*` を上書き・削除する | `ai-runner.ts:2856,3263-3303,3514,3524` | **実害（所有者の resume 先が壊れる）** | ✅ 実施済み（legacy も含め一時セッション全般で deny。読み出しのみ isolated だけ deny ＝ G-5b、新たに判明した別軸） |
| G-6 | terminalMode でも同様に所有者の `claude-session-id` を上書きする | `terminal-runner.ts:451,1265` | 実害 | ✅ 実施済み（`TerminalRunOptions.persistProjectState` を新設、linux のみ） |
| G-7 | Devin plan ターンの `git-guard` が所有者の作業ツリーを `git checkout`/`reset` で巻き戻す | `connection.ts:2087-2099` | **実害（最重大）** | ✅ 実施済み（巻き戻しは変更せず、読み取り専用を権限で強制できない実効 AI——devin/gemini/claude+terminalMode——へのクロスユーザー ask 自体を AI 起動前に拒否する設計に一般化。サーバー側が主防御、Agent 側 2 箇所が最後の砦） |
| G-8 | `resetApproveAllMode()` が無条件で所有者の「以降すべて許可」を解除 | `connection.ts:942` | 挙動汚染 | ✅ 実施済み（一時セッション全般——legacy 含む——で機体グローバル状態の読み書きを遮断。windows には当該機構が無いため対象外） |
| G-9 | Devin 経路が `/tmp/devrelay-prompt-<sid>.txt`（0644）に質問全文を残し、失敗ターンでは削除しない | `ai-runner.ts:2447-2448,3230-3234` | 情報露出 | ✅ 実施済み（0600 で作り直し、一時セッションは失敗ターンでも必ず削除） |
| G-10 | `savePlanFile` が scope 分離されておらず、並行スレッドが `.devrelay/plans/` を共有して 20 件超で互いのプランを `unlink` する | `plan-file-store.ts:13,25,84` | 既存の非対称（resume とは無関係） | 対象外（別サイクル） |

加えてサーバー側:

| # | 内容 | 場所 | 状態 |
|---|---|---|---|
| G-11 | **WebUI/チャットのクロス ask に 5 分窓のレート制限が無い**（宛先単位の inflight ガードのみ）。Agent REST 経路（`document-api.ts:705,712`）だけが持っている。**resume で会話が長期化する前に C2 で足す** | `cross-ask-runner.ts:90-112` に `countRecentCrossSessions()` を追加 | 対象外（C2 で実施） |
| G-12 | `handleProjectConnect` の active 候補 where に `crossquery_` 除外が無く、宛先所有者が自分のプロジェクトを `//connect` すると実行中のクロス ask セッションを拾い得る（`document-api.ts:764` が既存の見本） | `command-handler.ts:534-541` | ✅ 実施済み（active と ended 復活候補の両方に `buildEphemeralSessionIdExclusion()` を適用。調査で ended 側も同じ穴と判明） |

---

# 3 OS の差分

| 項目 | linux（Windows CLI もこれ） | macos | windows（Electron GUI） |
|---|---|---|---|
| `session-scope.ts` / `scope-dir.ts` | 67 / 70 行 | **byte-for-byte 同一** | **byte-for-byte 同一** |
| `connection.ts` の ephemeral ガード | `947,959,968,987,1157,1177,1184,1200,1250,1277,1278,1363,1370,1636,1769,1888,1922,2020` | 全て存在（`1020,1033,1040,1059,1214,1248,1255,1271,1312,1339,1340,1416,1423,1617,1695,1810,1844,1933`） | 概ね存在（`396,408,415,434,561,581,588,604,644,697,704,888,980,1008,1091`） |
| `savePlanFile` | あり（`1769`） | あり（`1695`） | **呼び出し無し**（`plan-file-store.ts` 未配線）→ 変更 1 箇所少ない |
| `collectOutputFiles` | `1844,1985` | `1769,1899` | `945,1059` |
| `loadStorageContext` 注入 | `1397` | `1450` | `734` |
| `persistProjectState` | `1636,1950` → `ai-runner.ts` 6 箇所 | `1617,1864` | `888,1021` → `ai-runner.ts:572,1519,1530`（2 箇所のみ、SDK 経路なし） |
| terminal mode（PTY） | `terminal-runner.ts` あり | **ファイル自体が無い**（`ai-runner.ts:3371` に明記） | **PTY 非対応** |
| Claude Agent SDK 経路 | あり | あり | **無し（spawn のみ、`sdk-*` は `sdk-stop-reason.ts` だけ）** |
| `session-store.ts` | `SessionMeta` / `saveClaudeSessionId(.., mode, agentScopeId)` 4 引数 | **`SessionMeta` 無し・3 引数**（`macos/.../session-store.ts:61`）→ 実装時に署名差を吸収 | linux と byte-for-byte 同一 |
| `capabilities` 申告 | `connection.ts:336` 全件 | `:298` 全件 | `:197` `raw-completion` のみ除外 → `cross-ask-resume` は自動で申告される |
| `approval-logger.ts` | あり | あり | **無し** |
| `handleConversationClear`（リセットの実体） | `1089` | あり | `520`（clear 対象 7 ファイルも同一） |

**Windows の扱い**: 本番の Windows は `scripts/install-agent.ps1:72` で
`agents/linux/dist/index.js` を実行するため **linux 列がそのまま適用される**。
`agents/windows` は Electron tray GUI（+ レガシー CLI）用の独立実装で、
PTY も SDK も `savePlanFile` も持たないぶん**変更箇所が最も少なく、構造的に最も安全**。
ただし 3 ディレクトリ全部に同じ変更を入れる（`session-scope.ts` は byte-for-byte 同一規約）。

---

# 検証手順

## 自動
```bash
pnpm build                                     # 全 6 workspace green
cd apps/server     && node --test tests/       # 1540 + 新規
cd apps/web        && node --test tests/       # 971 + 新規
cd agents/linux    && node --test tests/       # 1275 + 新規
cd agents/macos    && node --test tests/       # 756 + 新規
cd agents/windows  && node --test tests/       # 155 + 新規
grep -c 'require(' apps/web/dist/assets/index-*.js   # 必ず 0
```

## 実機（所有者プロジェクトの不変性 — ここが本サイクルの合否）
貸す側マシンで、ask の**前後**に以下を取って差分ゼロを確認する:

```bash
P=/path/to/owner/project
# 1) 成果物（#348 の再発検知）
ls -la --time-style=full-iso "$P/.devrelay-output/" | md5sum
ls "$P/.devrelay-output-history/" | wc -l
# 2) 既定スレッドの会話・resume 状態（projectPath 直下。絶対に触られてはいけない）
stat -c '%y %s' "$P/.devrelay/conversation.json"
stat -c '%y' "$P/.devrelay/claude-session-id" "$P/.devrelay/codex-session-id" 2>/dev/null
# 3) プラン（増殖検知）
ls "$P/.devrelay/plans/" | wc -l
# 4) work state（消費検知）／添付（混入検知）／巻き戻し（G-7 検知）
ls -la "$P/.devrelay/work_state.json" "$P/.devrelay/work-states/" "$P/.devrelay-files/" "$P/.devrelay/reverted/" 2>/dev/null
# 5) 逆に scope dir だけが増える／更新されることを確認
ls -la "$P/.devrelay/sessions/"
stat -c '%y %s' "$P"/.devrelay/sessions/crossask-*/conversation.json
# 6) 所有者側の git が汚れていないこと
cd "$P" && git status --porcelain
```

3 往復して「2 往復目以降、前の質問を覚えている」ことと、1〜4 と 6 が不変であることを
**同時に**満たすのが合格。5 の `conversation.json` は毎ターン更新されるのが正しい。

## DB
```sql
-- KnowledgeChunk に行が出来ていないこと（crossquery_ 維持の確認）
SELECT count(*) FROM "KnowledgeChunk" kc
  JOIN "Message" m ON m.id = kc."sourceId"
 WHERE m."sessionId" LIKE 'crossquery_%';            -- 必ず 0

-- 同一ペアの agentScopeId が安定していること（= 決定論的採番の実証）
SELECT "projectId","requestedByUserId","agentScopeId", count(*) AS turns
  FROM "Session" WHERE id LIKE 'crossquery_%' AND "agentScopeId" IS NOT NULL
 GROUP BY 1,2,3;                                      -- ペアごとに 1 行・turns が往復数

-- 1 ターン 1 行のままで、監査が 1:1 で残っていること
SELECT action, count(*) FROM "CrossTeamAuditLog"
 WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1;

-- スレッド一覧に漏れていないこと
SELECT count(*) FROM "Session" WHERE id LIKE 'crossquery_%' AND status = 'active'
   AND "startedAt" < now() - interval '30 minutes';   -- 0（置き去りが無い）
```

## 未更新 Agent での縮退確認
1. 貸す側マシンで `u` を**打たずに** `DEVRELAY_CROSS_ASK_RESUME=1` のまま ask
2. サーバーログに「resume skipped（capability 未申告）」が出ること
3. 回答が「覚えていない」こと＋案B の前置が効いていること（2 往復目で前の話題を参照できる）
4. 上記「実機」1〜4 と 6 が不変であること
5. `ls "$P/.devrelay/sessions/"` に `crossask-*` が**作られていない**こと

---

# 人間側の作業

1. `pnpm build` 後 — **サーバー**: `pm2 restart devrelay-server`（C2/C3 時）
2. **貸す側マシン**の Agent 更新（C1/G 時）: チャットで `u`
   （`/opt/devrelay` を commit + push してからでないと届かない）
   - 対象は「購読/招待で貸しているプロジェクトを持つ全マシン」。借りる側の更新は不要
   - Linux/macOS/Windows CLI は `u`、Windows Electron GUI は GUI 版の更新手順
3. `/opt/devrelay/.env`（`apps/server/.env` への symlink）に
   `DEVRELAY_CROSS_ASK_RESUME=1` を追記 → `pm2 restart devrelay-server`
   （`--update-env` は使わない）
4. DB 変更は無し（マイグレーション不要）

# 残るリスク

| リスク | 深刻度 | 緩和 |
|---|---|---|
| scope dir の `conversation.json` に `exec` マーカーが混入すると exec に転ぶ（strictReadonly 失効 + `CLAUDE.md` 書換） | 高（理論上） | `forcePlanTurn` + ロード時の `exec` 除去 + Devin 除外の三段防御 + 静的テスト |
| 所有者プロジェクト内に `.devrelay/sessions/crossask-*/` が増える（依頼者×プロジェクトごとに 1 つ） | 中 | TTL クリア + 取消時 best-effort clear。中身は数十 KB の JSON、`.devrelay/` 配下 |
| 所有者のトークン消費が往復数に比例 | 中 | 上限ターン + TTL + リセットボタン。課金主体は変えない |
| C1/C2 の配布ずれ | 低 | どちらの順でも degrade のみ。capability で明示判定 |
| `document-api.ts` の ask 経路（Agent REST / `devrelay-ask-member` スキル / MCP `ask_project`）は resume 対象外のまま | 低 | 本サイクルの対象外として明記。Phase C の既知課題（スキルから購読宛先を引けない）と同じ場所で後続対応 |
| 既存バグ G-3〜G-12 を残したまま resume を入れる | 中 | G サイクルで分離。resume 経路では全て deny になるので**悪化はしない**（むしろ cross ask は改善する） |
| `requestedByUserId` に index が無い（履歴 API・案B の全件 `findMany`） | 低 | resume が効くと案B のクエリ自体が走らなくなるので実質改善。index 追加は別サイクル（マイグレーション必要） |
