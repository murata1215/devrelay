# サイクルS1: プランモードの Bash 制限が効いていない件 — 原因確定と修正計画

> 本ファイルは Plan フェーズで `/home/devrelay/.claude/plans/soft-bubbling-eich.md` に書いた
> プラン全文をそのまま repo にコピーしたもの（exec 承認メモの要求）。exec の Step 0
> （§5-0、実装直前の実測）の実測結果は以下のとおり（一時ディレクトリ・読み取り専用コマンドのみ）:
>
> | variant | フック呼び出し (Bash) | canUseTool 呼び出し | 結果 |
> |---|---|---|---|
> | `hook`（PreToolUse + canUseTool） | **2/2**（python3, ls） | **0** | python3 denied（`is_error:true`、hook の reason が honored）、ls allowed + 実行成功 |
> | `automode`（`settings:{autoModeEnabled:false}` + canUseTool deny-all） | 0 | **0** | python3 が実行された（出力 `"1"`）→ **item 5（settings override）は無効と確定、削除** |
> | `default`（permissionMode:'default' + canUseTool deny-all） | 0 | **1**（python3） | plan モード以外では canUseTool が従来どおり機能することを確認 |
>
> 結論: フックは classifier より前に解決し、判定が honored される（「実装せずに止めて差分を報告する」
> 条件には当たらない）。推奨案 (c) をそのまま実装、item 5 のみ削除。S1a 実装後、同じ構成で再実測し
> （`agents/{linux,macos}/tests/plan-gate-live.test.mjs`、`DEVRELAY_PLAN_GATE_LIVE=1`）、
> 同じ結果（hook 2/2・canUseTool 0・python3 deny・ls allow）を確認済み。

Step 0 確認済み: `git status` clean / HEAD = `f331484`。

## Context（なぜ直すのか）

読み取り専用であるはずのターン（チャットのプランターン、MCP Plan、MCP ask、クロスユーザー ask）で、
Bash が DevRelay の `decidePlanPermission()` を通らずに実行されている。`agents/linux/src/services/plan-permission.ts`
のゲート本体は無傷（MCP ツールと Edit/Write には今も効いている）だが、**Bash は `canUseTool` に到達しない**。
結果として、他人のプロジェクトへの質問ターンでファイル書き込み・外部送信を構造的に止められていない。

---

## 1. 原因の確定

### 1-A. 前提（確定）: `canUseTool` は「ask に落ちたときだけ」呼ばれる

SDK 0.3.282 に `cli.js` は無く、権限判定は同梱ネイティブバイナリ（Claude Code **2.1.282**, 228MB,
build 2026-09-24）の中にある。全ツール共通の判定関数 `x0t()` の順序（バイナリ直読、上から最初に確定したものが決定）:

1. bare deny ルール → deny
2. content deny ルール → deny
3. bare ask ルール → ask
4. `tool.checkPermissions()`（ツール固有判定。Bash のコマンド別判定、ファイル系の plan 書き込み禁止はここ）
5. **auto-mode classifier 補正**
6. content ask ルール → ask
7. `requiresUserInteraction()` → ask
8. `bypassPermissions` → allow
9. **bare allow ルール → allow**（`--allowedTools Bash` が全 Bash を通す実体）
10. 残り `passthrough` → ask に変換 → **ここで初めて `can_use_tool` control_request（= DevRelay の `canUseTool`）**

SDK の型定義も明記（`sdk.d.ts:5453`）:「Denials that resolve before canUseTool runs — **PreToolUse hook
denies**, deny-rule overrides of hook allow/ask decisions, and file-tool calls refused by a path-scoped
deny rule — are not covered here」。

plan モード固有の ask（`Cannot write to … while in plan mode` / MCP の `Cannot call … while in plan mode`）は
**step 9 の bare allow より前に return する**ため `allowedTools` では上書きできず、必ず `canUseTool` に来る。
これが「Edit は 2026-11-07 に deny 記録が残り、MCP `list_projects` は 2026-11-11 に deny された」理由。

### 1-B. 真因（確定）: `permissionMode:'plan'` が CLI 内部で auto モードに変換され、classifier が `canUseTool` の代わりに判定している

バイナリ内の該当コード（関数名は minified）:

```js
function VR(e){ aB().setActive(e) }                 // auto モード active フラグの setter
function hg(){ return aB().active }                 // getter
function oMr(){ return Rcn("useAutoModeDuringPlan") }   // ★ 機能ゲート
function xS(){ /* circuit-breaker / settings / モデル対応 の 3 条件 */ }
function zEn(){ return xS() && oMr() }
function UKt(e){ if(!zEn()) return null; return VR(!0), L1(e) }   // ★ auto を ON にし、auto と同じ変換 L1 を適用
// 起動時:
if (e.permissionMode === "plan") { let b = UKt(r); if (b) r = { ...b, prePlanMode: "default" } }
// 判定経路の選択:
function La(e, r=!1){ return e==="auto" || e==="plan" && !r && hg() }
```

→ **`permissionMode:'plan'` で起動すると、機能ゲート `useAutoModeDuringPlan` が有効な限り CLI は
auto モードを ON にし（`VR(true)`）、`permissionMode:'auto'` と同じ権限コンテキスト変換 `L1` を適用する。**
以降 `La('plan', false)` が true になり、**プロンプトを出さない経路（auto-mode classifier が allow/deny を
出す経路）に入るため `can_use_tool` が発行されず、DevRelay の `canUseTool` は呼ばれない。**

これで観測が全て説明できる:

| 観測 | 説明 |
|---|---|
| Bash（`python3 -c`、複合コマンド）が無記録で実行された | classifier が allow。`canUseTool` 未発行＝`onAutoApproved` も呼ばれず JSONL に記録が残らない |
| MCP `list_projects` だけ `planPolicy:notInAllowlist` で deny された | MCP の plan-ask は step 4 で確定し classifier/bare allow より前に return → `canUseTool` に到達 |
| Edit が 2026-11-07 に deny 記録を残した | 同じ理由（plan の書き込み ask は先に return） |
| 2026-10-18 の `cd ... && grep ...` だけ deny 記録が残った | classifier が「要承認」と判断 → ask → `canUseTool` → DevRelay が deny |
| Read/Grep/Glob の承認記録も 2026-09-28 以降ほぼ消えた | 同じく classifier が allow |

**重要**: このゲートは**遠隔で切り替わり得る種類のフラグ**（`Rcn("useAutoModeDuringPlan")`）。
つまり SDK を固定していても挙動が変わり得る。**DevRelay 側の防御を CLI の挙動に依存させてはいけない**
という設計要件がここから出る。

**棄却した対案**（agent 調査の過程で有力視されたが、証拠で否定できたもの）:
- 「CLI の read-only 自動許可が python3 を通した」→ **否**。read-only 許可集合は**ハードコード**で
  `ls cat head tail wc stat grep egrep fgrep diff du df echo strings hexdump od nl cut column tr tac rev
  cmp basename dirname realpath readlink sha256sum sha1sum md5sum cd` + 正規表現群（`pwd whoami node -v jq
  uniq find ls cd echo` 等）で、**python 系は `python --version` / `python3 --version` だけ**。
  `python3 -c …` は read-only 扱いにならない。
- 「DevRelay 自身の `canUseTool` が `strictReadonly=false` で allow した」→ **否**。
  `connection.ts:1769-1779` の `onAutoApproved` は**無条件配線**で JSONL に `status:'auto'` を書くため、
  canUseTool が allow していれば記録が残る。当該プランターンの記録は 0 件（最初の記録は exec 開始後の Edit）。
- plan モードが Bash を遮断していない点自体も確認済み（`hLt()/oMo()` は `acceptEdits` のみ allow、
  plan 用の Bash ブロック文字列はバイナリ内に存在しない）。

### 1-C. 候補の裏づけ／棄却

| 候補 | 判定 | 根拠 |
|---|---|---|
| (a) `--allowedTools` の Bash ルール | **真因ではないが実在する穴** | ルールは `exact`（`Bash(pm2 logs)`）/ `prefix`（`Bash(cmd:*)`）/ `wildcard`（`Bash(find *)` → `*`→`.*` の正規表現。末尾 `" *"` は引数なしにもマッチ）の 3 型に解釈され、step 9 以前で allow を確定させ得る。`Bash` / `Bash()` / `Bash(*)` は**同一（= ツール全体の bare allow）**で、Bash は `ignoresWholeToolAllowRule` を実装していないため bare なら python3 も含め全部通る。所有者の `allowedTools:linux` 48 件に bare `Bash` は無いが、**裸の context7 MCP 2 件が実際に shadow されている**（警告ログの中身がそれ） |
| (b) `settingSources:['user','project']` 由来の permissions | **この機体では棄却（ただし恒久的な穴）** | 読まれるのは `~/.claude/settings.json`（`permissions` キー無し）と `<cwd>/.claude/settings.json`（全 40 プロジェクトで**存在しない**）。`permissions.allow` を持つのは `settings.local.json` 2 本だが `'local'` 未指定で読まれない。**`--settings`（flagSettings）と managed-settings（policySettings）は `settingSources` の指定に関わらず常に有効**（`ts()` が無条件に追加。managed は現在不在）。`permissions.allow` は `allowedTools` と**完全に同じ `alwaysAllowRules` テーブル**に入るため、将来 `.claude/settings.json` が 1 つ置かれるだけで黙って穴が開く。クロスユーザー ask では**所有者側の設定を読む**という隔離上の問題も残る |
| (c) SDK 0.3 の `permissionMode:'plan'` の扱い | **真因（1-B）** | `useAutoModeDuringPlan` ゲートで plan が auto に変換され、classifier が `canUseTool` の代わりに判定する |
| (d) サンドボックス／自動許可 | **棄却** | `sdkOptions.sandbox` は未指定、設定ファイルにも `sandbox` 無し。`isSandboxingEnabled() && isAutoAllowBashIfSandboxedEnabled()` の自動許可経路には入らない（= サンドボックスによる代替防御も無い＝書き込みは実際に成功し得る） |
| (e) `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告 | **本件とは別問題** | 警告生成関数 `Ka()` は `allowedTools` のうち **`(` を含まない裸エントリだけ**を列挙する実装。所有者の `allowedTools:linux`（UserSettings、48 エントリ）の末尾 2 件が裸の context7 MCP ツールなので毎ターン出ている。`Bash(... *)` 形式は列挙されないため **Bash の shadow は警告に現れない**（見逃しの一因） |
| (f) `canUseTool` が `onToolApprovalRequest` の有無に依存 | **今回の事象の原因ではないが構造的欠陥** | `ai-runner.ts:1172` の `if (options.onToolApprovalRequest) { ... }` に else が無く、未指定なら `canUseTool` ごと消える。実配線（`connection.ts:1748`）では常に設定されるため今回は発火していないが、修正対象に含める |

---

## 2. いつ壊れたか（確定）

| 日時(JST) | 出来事 |
|---|---|
| 2026-08-29 `add09f4` | strictReadonly ゲート導入（#332） |
| 2026-08-30 `486ebf4` | トークン単位判定（#333）。以後 Bash deny が記録され始める |
| 2026-08-29〜09-20 | **plan の Bash deny 計 331 件**（実例: `psql` 多数、`which claude; claude --version`、`claude plugin --help`） |
| **2026-09-20 16:07** | **`d87d003` SDK `0.2.80 → 0.3.278`**（SDK-2 ④b） |
| 2026-09-20 16:45 | **最後の plan Bash deny**（`~/.devrelay/approvals/archive/approvals_20260920094936.jsonl`） |
| **2026-09-20 18:49** | **稼働 Agent が自己更新し 0.3.278 が実機に入る**（`~/.devrelay/logs/update.log`） |
| 2026-09-25 `551f467` | `0.3.278 → 0.3.282`（現在） |
| 2026-09-20 以降 | **plan の Bash deny は 1 件のみ**（2026-10-18T03:08Z、`cd ... && grep ...` の複合コマンド。CLI が read-only と断定できず `canUseTool` に落ちた＝機構の裏づけ） |
| 2026-11-11 夜 | 稼働 Agent ログ: `📋 [SDK] Using plan mode with 48 allowed tools` の直後に Bash 数十回。同セッションの approvals 最初の記録は exec 開始後の Edit。plan 由来の `canUseTool` 到達は MCP deny 1 件のみ |

補足: 真因の `useAutoModeDuringPlan` は**遠隔で切り替わり得る機能ゲート**（`Rcn(...)`）なので、
断絶日は「SDK/CC がこの機能を持つ版（2.1.282 系）になった日」と「ゲートが有効化された日」の両方を
含み得る。どちらであっても **DevRelay 側はこれに依存しない防御を持つべき**という結論は変わらない。
SDK パッケージに CHANGELOG は無く、どの版で入ったかはローカル資料からは判定不能。

**原因コミット: `d87d003`（SDK バージョンバンプ）。DevRelay のゲート実装は 2026-09-12 `ae823fc` 以降 1 行も
変わっていない。** 0.3 移行サイクル（SDK-0/SDK-1/SDK-2）の調査 devlog と `doc/sdk-0.3-migration-findings.md`
には **`canUseTool` / `allowedTools` / plan パーミッション意味変更の検証が含まれていない**（型定義差分・
実行ファイル検出・モデル名のみ）。これが回帰を見逃した地点。

付随ドリフト（修正しないと S1 完了時に新たな障害になる）: `PLAN_READONLY_TOOLS` は今も `'Task'` を列挙するが、
SDK 0.3 のサブエージェントツール名は **`Agent`**（稼働ログ `Using tool: Agent`）。ゲートを直した瞬間に
サブエージェント起動が `planPolicy:notInAllowlist` で deny される。

---

## 3. 影響範囲

### 3-A. 経路 × 実効ゲート（claude / linux・macos、現状）

| 経路 | permissionPolicy | Bash | Write/Edit 系 | MCP ツール | 外部送信(curl/WebFetch) |
|---|---|---|---|---|---|
| チャットのプランターン | strictReadonly（既定） | **素通り** | 止まる | 止まる | 止まらない |
| MCP Plan（submit_instruction） | strictReadonly | **素通り** | 止まる | 止まる | 止まらない |
| MCP ask（ask_project） | strictReadonly | **素通り** | 止まる | 止まる | 止まらない |
| クロスユーザー ask | strictReadonly | **素通り** | 止まる | 止まる | 止まらない |

- Write/Edit/MultiEdit/NotebookEdit が止まる根拠は二重: CLI 自身の `Cannot write to … while in plan mode` と、
  `decidePlanPermission` の `writeTools` 最終防衛線（2026-11-07 に Edit deny の実記録あり＝到達している）。
- 外部送信: `Bash(curl *)` は所有者の allowedTools に入っており CLI が prefix allow、`WebFetch`/`WebSearch` は
  `PLAN_READONLY_TOOLS` に入っているため **DevRelay の方針としても現状「許可」**。ゲートを直しても止まらない
  （止めたいなら方針変更が必要＝サイクルS2候補）。
- 書き込み: 現在の実効判定は **auto-mode classifier（モデル判断）のみ**で、DevRelay の
  `PLAN_WRITE_BASH_COMMANDS`（`rm`/`mv`/`git commit` 等）やリダイレクト検出は**一切適用されていない**。
  classifier が止める保証は仕様上どこにも無く、`python3 -c "open('x','w')…"` のような経路は特に危うい。
  サンドボックスも無効（§1-C (d)）なので、通れば実際に書き込みが成功する。
  実測は exec Step 0 の再現テストで行う（**読み取り専用コマンドのみで、書き込みは試さない**）。

### 3-B. OS 別

| OS | 構造 | 現状 |
|---|---|---|
| linux（Windows CLI 版もこれを実行） | Agent SDK + `canUseTool` + `decidePlanPermission` | ゲートはあるが Bash で未到達 |
| macos | linux と同構造（`ai-runner.ts:1067/1069/1076/1138`、`plan-permission.ts` は JSDoc 1 行差のみでロジック同一） | 同上 |
| windows（Electron GUI 版） | `claude` CLI を直接 spawn（`--permission-mode plan` / `--disallowedTools ExitPlanMode` / `--allowedTools`）。**`canUseTool` も `plan-permission.ts` も存在しない** | DevRelay の方針は**元から一切適用されていない** |

### 3-C. AI 別

| AI | プランターンの読み取り専用強制 | 本件の影響 |
|---|---|---|
| claude | `canUseTool` + `PLAN_WRITE_TOOLS`（= 本件で Bash が抜けている） | **あり** |
| codex | CLI `-c sandbox_mode="read-only"`（プロセス外強制） | なし |
| devin / gemini / claude+terminalMode | 権限強制なし（プロンプト指示のみ。`ENFORCED_READONLY_AI_TOOLS` 対象外） | 元から保証なし |

### 3-D. Task / サブエージェント（本サイクルで確定）

サブエージェント発のツール呼び出しも**同一の単一 `canUseTool`** に `agentID` 付きで来る。根拠:
`sdk.d.ts:277` の `CanUseTool` options に `agentID?: string`（"If running within the context of a
sub-agent, the sub-agent's ID."）、バイナリ内 `system/permission_denied` スキーマの
`agent_id`（"Mirrors can_use_tool for host-side routing"）、PreToolUse hook 入力スキーマの
`agent_id` / `agent_type`。`constants.ts:294` の「実機 E2E で要確認」コメントはこれで確定扱いにできる。

ただし **ツール名が `Task` → `Agent` に変わっている**ため、`PLAN_READONLY_TOOLS` の更新が必要（§4-4）。

---

## 4. 修正案（比較と推奨）

| 案 | 内容 | 評価 |
|---|---|---|
| (a) Bash を `allowedTools` で渡すのをやめ全部 `canUseTool` で判定 | 所有者の `Bash(curl *)` 等による自動承認は消える | **単独では無意味**。真因は allow ルールではなく auto-mode classifier（§1-B）。ルールを 0 件にしても classifier が allow を出して `canUseTool` に来ない |
| (b) PreToolUse フックで強制 | `hooks.PreToolUse` のコールバックで `decidePlanPermission` を実行し `permissionDecision:'deny'` を返す | **本命**。SDK の型定義が「**PreToolUse hook denies は `canUseTool` が走る前に解決する**」と明記（`sdk.d.ts:5453`）。バイナリ側も `yield {type:"hookPermissionResult"}` で即 return。allow ルール・settings ファイル・classifier のいずれにも shadow されない見込み。SDK の警告文自身が "To gate every tool call, use a PreToolUse hook" と推奨。**ただし「classifier 経路より前か」はバイナリから断定できていないので Step 0 で実測する**（§5-0） |
| **(c) 両方 + 補助（推奨）** | (b) を権威にし、strictReadonly では `allowedTools` を SDK に渡さず、さらに `settings:{ autoModeEnabled:false }` を flagSettings 層で渡して plan→auto 変換自体を止める | 監査記録（`onAutoApproved`）が plan ターンに戻る。裸 `mcp__` の shadow も消える。classifier 経路も塞げる可能性がある（`autoModeEnabled` は policy 向け（scope `3p`）の可能性があり、flagSettings 層で効くかは Step 0 で実測） |

### 推奨: (c)

実装（`agents/{linux,macos}/src/services/ai-runner.ts` の plan 分岐、`agents/windows` は後述）:

1. **`sdkOptions.hooks.PreToolUse` を新設**（in-process コールバック。シェルスクリプトは使わない）
   - `ExitPlanMode` → `deny`
   - `AskUserQuestion` → 判定を返さない（従来どおり `canUseTool` → WS で人間に聞く経路を維持）
   - それ以外 → `decidePlanPermission()` をそのまま実行し、`deny` なら `permissionDecision:'deny'` +
     `permissionDecisionReason`（既存の日本語文言を再利用）、`allow` なら `permissionDecision:'allow'`
   - `onPolicyDenied` / `onAutoApproved` 通知をここから呼ぶ（Approvals タブ・JSONL の記録を復活させる）
   - **判定ロジックは `plan-permission.ts` に一切追加しない**（既存純関数の再利用のみ）
2. **`canUseTool` は `onToolApprovalRequest` の有無に関わらず常に設定する**（`if (options.onToolApprovalRequest)`
   の外に出し、未指定時は `AskUserQuestion` を deny、それ以外は同じ `decidePlanPermission` を適用）。
   これで「承認コールバックを渡し忘れると判定ごと消える」構造を潰す。第 2 防衛線として残す。
3. **strictReadonly のときは `sdkOptions.allowedTools` を渡さない**（`strictReadonly=false` の plan は現状維持）。
   同時に、strictReadonly で裸 `mcp__` エントリを SDK に渡さない扱いもこれで自動的に満たす。
4. `PLAN_READONLY_TOOLS` に `'Agent'` を追加（`'Task'` は旧 SDK 互換のため残す）。
   `packages/shared/src/constants.ts` の 1 箇所のみ。
5. **`settings: { autoModeEnabled: false }` を strictReadonly の plan ターンで渡す**（`flagSettings` 層は
   `settingSources` の指定に関わらず常に有効）。raw モードが既に `settings` オブジェクトを渡している
   前例があるのでやり方は同じ。Step 0 で効果を実測し、効かなければこの 1 項目だけ落とす
   （フックが本命なので落としても設計は崩れない）。
6. **設定ファイル由来の shadow の可視化**: plan ターン開始時に `~/.claude/settings.json` と
   `<cwd>/.claude/settings.json` に `permissions` キーがあれば 1 行警告ログを出す（読むだけ・挙動は変えない）。
   `settingSources` 自体は変更しない（`'project'` を外すと CLAUDE.md が読まれなくなり ask の回答品質が落ちるため）。
7. **フック到達の可観測性**: plan ターン開始時に `🪝 [SDK] PreToolUse gate enabled` を 1 行、
   ターン終了時に「フック到達 N 件 / deny M 件」を 1 行出す。**到達 0 件で Bash が走ったターンは
   サーバーへ警告を上げる**（同じ故障が次に起きたとき無言にならないようにする）。

**フォールバック（Step 0 でフックが classifier より後だと判明した場合）**:
- Plan B: `settings:{ autoModeEnabled:false }` が効くならそれで plan→auto 変換を止める（上記 5 が本命に昇格）。
- Plan C: strictReadonly の plan ターンだけ `permissionMode` を `'default'` にし、プランモードの意味づけは
  `planModeInstructions`（SDK オプション、CLI の plan reminder を差し替えられる）とプロンプトで維持する。
  `'default'` には plan→auto 変換が無いため全ツールが `canUseTool` に来る。失うのは CLI 側の
  `Cannot write to … while in plan mode` だが、`PLAN_WRITE_TOOLS` の最終防衛線が同じ役割を果たす。
  Plan C を採る場合は影響が大きいので、Step 0 の結果を持って一旦報告する（プラン逸脱の報告ルールに従う）。

キルスイッチ: **フック本体には置かない**（サイクルG の D2「最後の砦にはキルスイッチを置かない」に倣う）。
ロールバックは `git revert` + 該当機 `u`。サーバー側ゲート（S1b）にのみ `DEVRELAY_PLAN_GATE_CAPABILITY`（既定 `1`）を置く。

windows（Electron GUI 版）: `claude` CLI を spawn する構造のため in-process フックを足せない。
**本サイクルでは手を入れず、capability を申告しない**（= クロスユーザー ask の宛先から外れる）。
`agents/windows` 向けの CLI フック配布は次サイクル候補として記録する。

---

## 5. 再発防止のテスト

### 5-0. Step 0（実装前の実測。これで実装方針が確定する）

一時ディレクトリを `cwd` に、**書き込みを伴わない読み取り専用コマンドだけ**で実 SDK を起動し、
次の 3 点を 1 回の計測で確定させる。結果が想定と違えば §4 のフォールバックに切り替え、
実装前に差分を報告する。

1. `permissionMode:'plan'` + PreToolUse フック（deny を返す）で、Bash が**フックに到達するか**。
   到達すれば案 (b) が成立（本命）。到達しなければ Plan B / Plan C へ。
2. `settings:{ autoModeEnabled:false }` を足したとき、Bash が `canUseTool` に来るようになるか
   （= plan→auto 変換が止まるか）。
3. `permissionMode:'default'` のとき Bash が `canUseTool` に来るか（Plan C の実現性確認）。

### 5-A. 静的（`pnpm test` に常時組み込み、オフライン green）

- 新規 `agents/{linux,macos}/tests/plan-gate-wiring.test.mjs`（`cross-team-chat-wiring.test.mjs` と同じ
  ソース文字列検証方式）:
  1. `ai-runner.ts` の plan 分岐に `hooks` / `PreToolUse` の配線がある
  2. plan 分岐の `canUseTool` 代入が `if (options.onToolApprovalRequest)` ブロックの**外**にある
  3. strictReadonly のとき `sdkOptions.allowedTools` を設定しない分岐がある
  4. `decidePlanPermission` の呼び出しがフック側と `canUseTool` 側の 2 箇所にある
- 既存 `plan-permission.test.mjs` に追加: `python3 -c ...` / `node -e ...` / `psql ...` /
  `cd x && grep y`（複合）/ `echo a > b`（リダイレクト）/ `Agent` ツール名 の 6 群。
- `packages/shared/tests/` に `PLAN_READONLY_TOOLS` が `'Agent'` を含むことの回帰テスト。

### 5-B. 動的再現テスト（exec の Step 0 で手動実行、`pnpm test` では skip）

- 新規 `agents/linux/tests/plan-gate-live.test.mjs`。`DEVRELAY_PLAN_GATE_LIVE=1` のときだけ実行
  （既定 skip。`sdk-executable-real.test.mjs` と同じ「実物に当てる」系の流儀）。
- 内容: `mkdtemp()` した一時ディレクトリを `cwd` に、`permissionMode:'plan'` + 本サイクルの
  PreToolUse フック + `canUseTool` で実 SDK を起動し、**書き込みを伴わない**非許可コマンド
  （`python3 -c "print(1)"`）を要求するプロンプトを投げる。検証項目:
  1. フックが `Bash` について呼ばれたことを記録している（0 件なら red ＝ 本件の回帰検知）
  2. その Bash が実行されていない（deny された）
  3. `ls` 等の読み取り専用コマンドもフックに到達している（classifier に奪われていない）
- 後片付けは一時ディレクトリの削除のみ。所有者プロジェクトや `.devrelay-output/` には一切触れない。
- サブエージェント経由の到達は §3-D で型定義・スキーマから確定済みなので、このテストでは任意項目。

---

## 6. 配布の安全策

- `AgentCapability` に **`'plan-gate-hook'`** を追加（`packages/shared/src/types.ts:49/52`）。
  `agents/windows` はこれを除外して申告する。
- サーバー側: `cross-ask-isolation-rules.ts` と同じ流儀で、**クロスユーザー ask は未申告 Agent に対して断る**
  （`reason:'agent_outdated'`、監査ログあり、依頼者には「相手側に `u` を依頼してください」）。
  既存の `decideCrossAskIsolation()` に条件を 1 つ足すのではなく、capability 名だけを差し替えられる形で
  同関数に `agentHasPlanGateCapability` を追加する（判定順は capability → AI 安全性の既存順を維持）。
- **`readOnlyEnforced` を実態に合わせる**: `decideAskReadOnlyEnforcement()`（AI 種別の判定、純関数）は
  変えず、応答に載せる値を `aiEnforced && !terminalMode && agentHasCapability('plan-gate-hook')` で計算する
  薄い関数を `ask-guard.ts` に追加し、`mcp/tools.ts`（`ask_project`/`get_answer`）・`api.ts`・
  `document-api.ts`・`cross-ask-runner.ts` の 5 箇所で使う。未更新 Agent では `false` になり、
  `buildAskPromptPrefix()` の固定禁止文が自動的に付く（= 嘘をつかなくなる）。
- 同一ユーザーのチャット／MCP は**断らない**（自分の機体を自分で止めてしまうため）。断るのはクロスユーザー ask のみ。

---

## 7. 分割案（段階ごとに commit / push）

| 段 | 範囲 | 成果物 |
|---|---|---|
| **Step 0** | §5-0 の実測（一時ディレクトリ・読み取り専用コマンドのみ）。結果が想定と異なれば実装前に報告 | commit なし |
| **S1a** | Agent 側ゲート修正 + テスト。`agents/{linux,macos}/src/services/ai-runner.ts`、`packages/shared/src/constants.ts`（`'Agent'` 追加）、新規 wiring テスト、`plan-permission.test.mjs` 追加、`plan-gate-live.test.mjs`（skip 既定）。linux/macos で byte-identical を保つべき部分は維持 | commit 1 |
| **S1b** | capability + サーバー側。`packages/shared/src/types.ts`、`cross-ask-isolation-rules.ts`、`ask-guard.ts`、`mcp/tools.ts` 他 5 箇所、`agents/windows/src/services/connection.ts`（capability 除外）、サーバーテスト | commit 2 |
| **S1c** | 文書。`CLAUDE.md`（環境変数表に `DEVRELAY_PLAN_GATE_CAPABILITY`、capability 説明）、`rules/project.md`、`doc/sdk-0.3-migration-findings.md` に「権限意味変更の見落とし」追記、`doc/changelog.md`、devlog 新規 1 ファイル + `INDEX.md` 1 行 | commit 3 |

DB 変更: **なし**（`apps/server/db/changes/` への追加も不要）。

---

## 8. このサイクルに含めないもの（サイクルS2 以降）

クロスユーザー ask の隔離強化一式は S1 に含めない:

| 項目 | S1 が前提か |
|---|---|
| Claude の会話記録を世代ごとに分け、リセットで消す | **前提でない**（独立。`CrossAskReset` の延長） |
| 写し（transcript / `~/.claude/projects/<slug>`）を作らない | **前提でない** |
| MCP の明示遮断 | **部分的に不要**（plan モードでは MCP が必ず ask に格上げされ `canUseTool` で deny 済み＝既に効いている。明示 deny リスト化は品質向上のみ） |
| 読める範囲の制限（Read/Glob/Grep のパススコープ） | **S1 が前提**。現在 Read 系は CLI が先に allow するためゲートに来ない |
| 外部通信の制限（curl / WebFetch / WebSearch） | **S1 が前提**。かつ S1 完了後に「方針として許可している」現状（`Bash(curl *)` と `PLAN_READONLY_TOOLS` の `WebFetch`/`WebSearch`）を変える判断が別途必要 |

---

## 付記（本 Plan フェーズでの観測・衛生）

- 本プランターン中、筆者（AI）は許可一覧に無い `psql ... -c "select ..."` や `cd X && env ... psql ...`
  （複合コマンド）を実行できてしまった。意図的なゲート試験ではなく調査の副産物だが、
  **チャットのプランターンでもゲートが効いていないことの実地確認**になっている。書き込み・外部送信を
  伴うコマンドは実行していない。
- 所有者の `UserSettings.allowedTools:linux`（48 エントリ）は**読み取り専用 SELECT で確認**した。
  内容は `Bash(... *)` 46 件 + 裸の context7 MCP ツール 2 件。DB は変更していない。
- 衛生: `~/.devrelay/approvals/archive/` の 2026-09-05 分に DB 接続文字列（パスワード込み）が平文で
  残っている。本件とは独立の課題として別サイクルで扱う（内容はここに書かない）。

---

## 検証（exec 後に人間が確かめる手順）

1. `pnpm build` が green、`node --test` が各ワークスペースで green（件数は完了報告に記載）。
2. 人間作業（この順序）: ① `pm2 restart devrelay-server` ② 該当機で `u`（linux/macos。windows 機は対象外）
   ③ Agent ログに `🪝 [SDK] PreToolUse gate enabled` の起動行が出ることを確認。
3. ゲートが効いていることの確認: プランモードのチャットで AI に
   「`python3 -c "print(1)"` を実行して」と依頼し、
   `プランモードでは使用できません（理由: 許可ツール一覧にない…）` が返ること。
   同時に `~/.devrelay/approvals/current.jsonl` に当該ターンの `deny` 行が 1 件増えること。
4. 回帰確認: 同じプランターンで `git status` / `pm2 logs` / `ls` が従来どおり通ること、
   `AskUserQuestion` が従来どおり人間に届くこと。
5. クロスユーザー ask: 未更新 Agent 宛ての ask が
   「相手側の Agent が古く…`u` を依頼してください」で断られること。
