# `ask` 経路を「ゲーム席用の素の completion API」として使えるかの前提確認

- 調査日: 2026-09-19
- 対象: dangou-card（LLM 対戦ゲーム）から DevRelay `ask` 経路経由で Claude Code（Max サブスク）/
  Codex（ChatGPT サブスク）を 1 席のプレイヤーとして呼び出せるか
- 種別: read-only 調査（コード変更ゼロ）。本レポートと devlog 以外のファイルは触っていない

---

## 1. ask の HTTP 入口

- **エンドポイント**: `POST /api/agent/ask-member`
  （`apps/server/src/routes/document-api.ts:487`〜`703`。ハンドラ本体）
- **クライアント**: `~/.claude/skills/devrelay-ask-member/scripts/ask.sh`
- **認証**: `Authorization: Bearer <machine_token>`（`drl_...`）。
  `document-api.ts:488-491` で Bearer トークンから `prisma.machine.findFirst()`（`:173-178`）
  により `{ userId, machineId }` を解決
- **リクエスト JSON**: `{ targetProjectId: string, question: string, ai?: string, callerProjectPath?: string }`
  （必須 `targetProjectId`/`question`、`document-api.ts:493-495`）
- **レスポンス JSON**: `{ answer: string }`（`document-api.ts:691`）
- **同期/非同期**: **完全に同期**。ポーリングは不要で、`ask.sh` の curl 1 本の応答本文に
  回答テキストがそのまま入る（`document-api.ts:673-691` が `executeCrossProjectQuery()` の
  Promise を await してからレスポンスを返す）
- **タイムアウト**:
  - `ask.sh` 側 curl: **600 秒**（10 分。ask.sh 内 `--max-time 600` 相当の記述）
  - サーバー側（`executeCrossProjectQuery`）: `timeoutMs` 引数の**既定値 43,200,000 ms = 12 時間**
    （`apps/server/src/services/agent-manager.ts:1382`）。呼び出し側（`document-api.ts:673-681`）
    はこの引数を省略しているため既定値がそのまま使われる。
    **⚠️ 関数の JSDoc コメントは「デフォルト 5 分」と書かれているが実値は 12 時間で、
    コメントと実装が食い違っている**（詳細は §9「副産物」）
  - 実質的な上限は ask.sh 側の 600 秒であり、サーバー側 12 時間には通常到達しない
- **`--ai` 指定時の挙動（#325）**: `document-api.ts:546-572`
  - `ai` 未指定なら `targetProject.defaultAi` を使用（`:548`）
  - `ai` 指定時、`AI_TOOL_NAMES` に無い値は **400**
    (`` Unknown AI: '<ai>'. Valid: ... ``、`:550-553`)
  - 対象マシンで利用可能な AI 一覧を `getAiToolList()`（WebSocket 経由の live query、`:559`）で取得し、
    指定 AI が含まれなければ **400**（`` AI '<ai>' is not available on machine '<m>'. Available: ... ``、
    `:565-569`）。**静かなフォールバックはしない**
  - AI 一覧取得自体が失敗した場合は **503**（`:561-564`）

---

## 2. プロンプト注入の有無（ask 経路限定）

最終プロンプトの組み立ては Agent 側 `agents/linux/src/services/connection.ts:1156`
（`composeFullPrompt`）で行われる。ask は `crossquery_` プレフィックスの一時セッションであり、
`isEphemeralSession()`（`agents/linux/src/services/session-scope.ts`）により
`isEphemeral = true` として扱われる（`connection.ts:646,658,680`）。

### 2-1. DevRelay Agreement（~170行）
- **文字列連結ではなく CLAUDE.md 経由**で system prompt に載る。
- `agents/linux/src/services/ai-runner.ts:939`: Claude SDK 呼び出しの `sdkOptions` に
  `settingSources: ['user', 'project']` を設定している。
- Claude Agent SDK の型定義（`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.77_zod@4.4.3/
  node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1172-1180`）:
  > `'project'` - Project settings (`.claude/settings.json`)... Must include `'project'` to load CLAUDE.md files.
- つまり ask 経路も `settingSources` の変更を受けておらず、**対象プロジェクトの `CLAUDE.md`
  （多くは `rules/devrelay.md` を参照する形で Agreement 全文を間接的に読み込む）が
  ask のプロンプトにも付く**。ask 専用に `settingSources` を変える分岐は存在しない。
- **無効化フラグ**: 存在しない。`settingSources` は ask/chat/exec で共通の `ai-runner.ts:939` にハードコード。

### 2-2. `Previous conversation:` 履歴注入
- **ask では行われない**。`connection.ts:658`: `` const history = isEphemeral ? [] : await loadConversation(...) ``。
  ephemeral セッションは常に空履歴で開始する。
- `composeFullPrompt`（`connection.ts:1156-1181`）は `sessionInfo.history.length > 1 && includeHistory` の
  ときのみ `Previous conversation:\n${historyContext}` ブロックを追加する（`:1158,1180`）。
  ask は履歴が空なのでこの分岐に入らず、`Previous conversation:` は付かない。
- 通常経路（ephemeral でない場合）の履歴ソースは `.devrelay/conversation.json`（`loadConversation()`）で、
  件数上限は agents 側の `MAX_CONTEXT_MESSAGES` 相当（別調査で確認済み、ask には無関係のため詳細割愛）。

### 2-3. 言語ディレクティブ
- ask は `sendPromptToAgent()` 呼び出し時に `language` 引数を渡していない
  （`agent-manager.ts:1399-1412`、該当引数の位置は `undefined`）。
- `agent-manager.ts:1326`: `` const resolvedPermissionPolicy = permissionPolicy ?? 'interactive'; `` と
  同様のパターンで、`language` も未指定時はサーバー側 `resolvedLanguage`（UserSettings 由来の既定値、
  通常 `'ja'`）にフォールバックする。**呼び出し単位の言語指定はできない**。

### 2-4. plan/exec モード指示
- ask は「exec マーカー」が履歴に存在しない（履歴が空のため）ので、
  `connection.ts:1070-1074`: `` const isPlanTurn = !isExecTriggered; `` により
  **常に `isPlanTurn = true`**（planモード扱い）。
- `connection.ts:1112`: `` const modeInstruction = isPlanTurn ? PLAN_MODE_INSTRUCTION : EXEC_MODE_INSTRUCTION; ``
  → ask には常に `PLAN_MODE_INSTRUCTION`
  （`agents/linux/src/services/output-collector.ts:161-173`、「現在はプランモードです...」の日本語文）が
  プロンプト先頭に付く。
- 加えて `agent-manager.ts:1411`: `resolvePermissionPolicy('ask')` が呼ばれ、
  `apps/server/src/services/permission-policy.ts:41-42` により ask は無条件で `'strictReadonly'` を返す。
  これは環境変数 `DEVRELAY_PLAN_STRICT_CHAT` の対象外（同変数は `'chat'` ソースのみに作用し、
  `'ask'`/`'mcp'` には最初から無条件で strictReadonly が適用されるため、ask に関しては
  そもそもキルスイッチが存在しない設計）。

### 2-5. provenance fence / human-input wrapper
- `<human-input kind="...">` フェンス（#334/#335）は **chat 経由の人間入力**（`e,<instruction>` や
  `<project>: <question>` の形式でユーザーが DevRelay チャットに直接入力したテキスト）を対象にした
  ゲートであり、`apps/server/src/services/command-handler.ts` 内の chat コマンド処理経路にのみ実装されている。
  **ask-member の REST エンドポイント（`document-api.ts`）はこのフェンス処理を通らない**
  （`document-api.ts` は `human-text-fence.ts` を import していない。grep で確認済み）。
  ask の `question` フィールドはフェンスなしでそのまま `prisma.message.create()`（`:631-639`）に保存され、
  そのまま `executeCrossProjectQuery()` 経由でプロンプトの一部になる。

### 2-6. `.devrelay-output/` 出力先指示
- 常に付く。`connection.ts:1157`: `basePrompt` の末尾に `OUTPUT_DIR_INSTRUCTION`
  （`agents/linux/src/services/output-collector.ts:154-158`）を無条件で連結している。
  ephemeral 判定による分岐は無い。

### 2-7. CLAUDE.md 自動読み込みの主体
- DevRelay 自身がプロンプトに CLAUDE.md の内容を文字列展開しているわけではない。
  §2-1 の通り、**Claude SDK 自身**が `settingSources: ['project']` を渡された結果として
  CLAUDE.md（および `.claude/settings.json`）を自律的に読み込む（sdk.d.ts の仕様どおり）。
  DevRelay 側のコードで CLAUDE.md をパースして prompt 文字列に結合している箇所はない。

### 2-8 無効化フラグまとめ
| 注入物 | ask で無効化する既存フラグ | 有無 |
|---|---|---|
| Agreement (CLAUDE.md 経由) | なし（`settingSources` は固定） | 無 |
| 履歴 (`Previous conversation:`) | `isEphemeralSession()` により自動無効（既存動作） | 有（既定で無効） |
| 言語ディレクティブ | なし（未指定時は UserSettings 既定に自動フォールバック） | 無 |
| plan モード指示 / strictReadonly | なし（`ask` ソースは無条件 strictReadonly、キルスイッチ対象外） | 無 |
| provenance fence | 該当なし（そもそも ask には適用されていない） | N/A |
| `.devrelay-output/` 指示 | なし | 無 |

---

## 3. モデル選択

- **使用されるキー**: ask は **plan 側のモデル設定**を使う。
  `apps/server/src/services/agent-manager.ts:1316-1318`:
  ```
  if (resolvedModel === undefined && isModelSelectableAiTool(resolvedAiTool)) {
    resolvedModel = await resolveModelForTool(userId, resolvedAiTool, 'plan');
  }
  ```
  ask 経路（`executeCrossProjectQuery`）は `sendPromptToAgent()` の `model` 引数に
  常に `undefined` を渡している（`agent-manager.ts:1409` のコメント `// model`）ため、
  上記のフォールバックが必ず発動し、`UserSettings.<tool>_model_plan`
  （`user-settings.ts:182-196` の `MODEL_SETTING_KEY_MAP`）が使われる。
- **呼び出し単位のモデル上書き**:
  - `ask.sh` / HTTP リクエストボディのいずれにも `model` パラメータは存在しない
    （`document-api.ts:493` のフィールド検証に `model` は無い）。
  - `--ai` はツール（claude/codex/gemini/devin/aider）の選択であり、**モデルの選択ではない**。
  - よって**「Claude で `claude-fable-5-1`、Codex で `gpt-5.6-terra` を今回の呼び出しだけ指定する」
    ことは現状の ask では不可能**。ユーザー設定（UserSettings の plan モデル）を事前に変更する
    以外に手段がない。
- **CLI/SDK への実際の渡し方**（`agents/linux/src/services/ai-runner.ts`）:
  - Claude: SDK `query()` の `options.model`（`:948`: `` if (options.model) { ... sdkOptions.model ... } `` 相当、
    `:936-956` 周辺で `sdkOptions` に設定）
  - Codex: `-c model="<value>"`（TOML 文字列として渡す。`:2120-2122`。
    ダブルクォート必須・値はサーバー側で危険文字除去済み）
  - Gemini: `-m <value>`
  - Devin: `--model <value>`（fuzzy 名対応。`opus` → `opus-low/-medium/-high/-xhigh/-max` 等）
- **モデル ID カタログ**: `packages/shared/src/constants.ts:72-123`
  - Claude: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `opus`, `sonnet`, `haiku`
  - Codex: `gpt-5.6-sol`(既定), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`
  - Gemini: `gemini-3.1-pro`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`
  - Devin: `adaptive`(既定), `opus`, `sonnet`, `haiku`, `claude-fable-5.1`, `gpt`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex`, `gemini`, `gemini-3.1-pro`, `swe`, `glm-5.3`
  - カタログはあくまで UI 上の参考値で、CLI へは任意の文字列がそのまま渡る（サーバー側でカタログ外の値を拒否する検証はない）

---

## 4. ツール・権限

- ask は plan モードとして起動する（§2-4）。
  `agents/linux/src/services/ai-runner.ts:985-991`:
  ```
  if (options.usePlanMode) {
    sdkOptions.permissionMode = 'plan';
    if (options.allowedTools && options.allowedTools.length > 0) {
      sdkOptions.allowedTools = options.allowedTools;
    }
  }
  ```
  `connection.ts:1303`: `` allowedTools: usePlanMode ? (serverAllowedTools ?? DEFAULT_ALLOWED_TOOLS_LINUX) : undefined ``
  → ask では `DEFAULT_ALLOWED_TOOLS_LINUX`（`packages/shared/src/constants.ts:162-227`、
  Read/Grep/Glob 等の読み取り系ツール＋pm2 logs 等の読み取り系 bash コマンド、約60パターン）が既定で許可される。
- **全ツール無効化の手段**: **無い**。
  `ai-runner.ts:987`: `` if (options.allowedTools && options.allowedTools.length > 0) `` という条件式のため、
  空配列 `[]` を渡しても「未指定」と同じ扱いになり、`allowedTools` セットが SDK に渡らず
  **素の plan モード（SDK 既定の read-only ツール一式）にフォールバックする**。
  つまり `allowedTools: []` で全ツールを閉じることはできない。
  `disallowedTools`（`:977-982`）は `AskUserQuestion`（`disableAsk` 時）と `ExitPlanMode`
  （plan モード時、#303）の 2 種類のみをブロックする専用リストで、汎用の「全ツール禁止」用途には使えない。
- **system prompt 完全置換の手段**:
  - Claude SDK には `systemPrompt?: string | { type: 'preset', preset: 'claude_code', append?: string }` という
    完全置換用オプションが型として存在する
    （`sdk.d.ts:1210-1227`。文字列を渡せばプリセットを使わず完全に独自の system prompt に差し替えられる）。
  - **しかし DevRelay の `ai-runner.ts` はこのオプションを一切設定していない**
    （`sdkOptions` 構築箇所 `:936-1178` 付近を全数確認、`systemPrompt` へのキー代入は無し）。
    したがって現状 Claude SDK は常に既定の `claude_code` プリセット system prompt のままで動いている。
  - Codex 側は `--append-system-prompt` に相当する引数すら未配線（`ai-runner.ts` の codex 起動部
    `:2100-2150` 付近を確認、system prompt 関連の CLI フラグは一切渡していない）。
    Codex CLI 自体が `-c` 経由の system prompt override をサポートしているかは本調査のスコープ外
    （DevRelay 側が使っていないことのみ確定）。

---

## 5. セッション・ステート

- **新規/相乗り**: ask 1 回ごとに **完全に新規の使い捨てセッション**。
  `document-api.ts:617-628`: `` const tempSessionId = `crossquery_${crypto.randomUUID()}`; ``
  で毎回 UUID 付きセッションを作成する。既存のプロジェクトセッションへの相乗りは無い。
- **resume / JSONL 継続**: 発生しない。
  - `connection.ts:680`: `` const claudeResumeSessionId = isEphemeral ? undefined : await loadClaudeSessionId(...); ``
    → ephemeral（ask 含む）は resume 用セッション ID を読まない。
  - `agent-manager.ts:1408`（`sendPromptToAgent` 呼び出しの `forceNewSession` 引数位置）は
    `executeCrossProjectQuery` からは `undefined` で渡されるが、`isEphemeral` 判定自体が
    セッション ID プレフィックス（`crossquery_`）で決まるため、`forceNewSession` を明示しなくても
    resume は発生しない。
  - conversation.json への読み書きも `isEphemeral` でガードされ発生しない（`connection.ts:1056,1063,1451,1570,1604,1692`）。
  - **まっさらにする特別な手段は不要** — ask は既にデフォルトで毎回まっさらである。
- **並行制御**:
  - `apps/server/src/services/cross-query-guard.ts:114-143`（`decideCrossTarget()`）が
    **同一ターゲットプロジェクトへの同時実行を 1 件までに制限**する。
  - Rule B（`:127-130`）: 15 分の実行中判定窓（`ASK_INFLIGHT_WINDOW_MS = 15 * 60 * 1000`、`:82`）内に
    `active` な `crossquery_` セッションが 1 件でもあれば、新規リクエストは **429 targetBusy**
    （`buildCrossTargetRejectionMessage()`, `:170-172`: 「混雑エラー: ... 現在別の問い合わせを処理中です」）
    で**拒否される（キューイングではない。並走もしない）**。
  - つまり同一プロジェクトへの ask は **直列化ですらなく、2 件目は即座に reject される**。

---

## 6. レート制限・ループガード（ゲーム用途にとって最大の障壁）

`apps/server/src/routes/document-api.ts:35-46`:

```ts
const CROSS_RATE_WINDOW_MS = 5 * 60 * 1000;        // :36  5分窓
const CROSS_INFLIGHT_WINDOW_MS = 65 * 60 * 1000;   // :38  teamexec 用
const TEAMEXEC_TARGET_LIMIT = 5;                    // :40
const TEAMEXEC_USER_LIMIT = 12;                     // :42
const ASK_TARGET_LIMIT = 8;                         // :44  ask 同一ターゲット上限
const ASK_USER_LIMIT = 20;                          // :46  ask ユーザー全体上限
```
（ask の実行中判定窓 `ASK_INFLIGHT_WINDOW_MS = 15 * 60 * 1000` は `cross-query-guard.ts:82`）

実装箇所:
- ループ検知（同一マシン→同一ターゲット、5分3回以上で拒否）: `document-api.ts:574-587`
- ターゲット別レート（`ASK_TARGET_LIMIT=8`）: `:591-597`（`countRecentCrossSessions('crossquery_', userId, targetProjectId)`）
- ユーザー全体レート（`ASK_USER_LIMIT=20`）: `:598-604`
- すべての 429 応答に `NO_RETRY_NOTE`（`:52`）が付与される
  （「同じ依頼を文面を変えて再送しないでください。ユーザーに状況を報告して停止してください。」）

### 6-1. 数値との突き合わせ
ゲーム側要件: 1 席あたり約 150 コール / 試合、試合は 1〜2 時間、ピークで**1 コール / 20 秒程度**。

- ピーク時のレートを 5 分窓に換算すると **15 回 / 5 分**。
- `ASK_TARGET_LIMIT = 8 回 / 5 分` を**約 2 倍上回る**ため、ピーク帯では確実に 429 に当たる。
- さらに `ASK_INFLIGHT_WINDOW_MS`（15 分窓・同時実行 1 件まで）により、
  1 コールの応答が返る前に次のコールを送ると即座に 429 targetBusy になる
  （通常は 10〜60 秒で応答が返る想定なので、順番待ちなしで直列に呼べば実行中判定自体には
  引っかからない可能性が高いが、レート上限 8 回/5分 には確実に抵触する）。
- 複数プレイヤー（複数ターゲットプロジェクト）に分散させても `ASK_USER_LIMIT = 20 回 / 5 分`
  という**ユーザー全体の backstop**があるため、1 ユーザーが複数席を持つ設計だと
  なおさら早く上限に達する。
- **結論**: 現状の ask のレート制限定数は「読み取り専用の低頻度な問い合わせ」を想定しており、
  ゲームのターン制対戦（高頻度・短時間）とは設計目的が根本的に異なる。**文言や設定変更では
  回避できず、コード側の定数変更または専用パスの新設が必須**。

### 6-2. Team 登録 (allowlist) の要件
- `checkCrossTargetAllowed(machineId, userId, targetProjectId)`
  （`document-api.ts:110-131`）が ask/teamexec 双方の入口で呼ばれる。
- ルール: **ターゲットプロジェクトが、呼び出し元マシンのいずれかのプロジェクトと同じ Team に
  登録されている**必要がある（`TeamMember` テーブルで、caller 側マシンの projectId と
  target の projectId が**同一 `teamId`** に属していること）。
- **例外（legacy 救済）**: ユーザーが Team を 1 件も作っていない場合（Team 数 = 0）は
  全プロジェクトへの ask/teamexec を許可する（`:127-128` 付近のフォールバック）。
- 未登録の場合は **403** で、登録済み宛先の一覧付きメッセージが返る
  （`buildUnregisteredTargetMessage()` 相当のロジック、`:137-152`）。
- **testflight で作った新規プロジェクトを ask 対象にする手順**:
  1. WebUI の Team ページ（または `POST /api/teams` で新規 Team 作成、既存なら不要）
  2. `POST /api/teams/:teamId/members` に `{ projectId: <testflightプロジェクトのID> }` を送信し、
     dangou-card 側のプロジェクトと同じ Team に登録する
  3. チャットコマンドでの登録手段は存在しない（WebUI/REST のみ）

---

## 7. usage・課金の記録

- ask 完了時、Agent から `agent:ai:output`（`isComplete=true`）で返る `usageData` が
  `Message.usageData`（JSON カラム）にそのまま保存される
  （`agent-manager.ts` の該当ハンドラ。テーブルは `prisma/schema.prisma` の `Message` モデル、
  `sessionId, role:'ai', content, platform:'system', usageData` の形で1レコード）。
- `AiUsageData` の型（`packages/shared/src/types.ts:287-301`）:
  ```ts
  export interface AiUsageData {
    usage?: Record<string, number>;      // per-request: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens 等
    modelUsage?: Record<string, any>;    // モデル別セッション累計: contextWindow / input / output / cacheRead / cacheCreation
    durationMs?: number;
    model?: string;
    rateLimits?: { fiveHour?; sevenDay? };
  }
  ```
- **Codex でも同等の usage が取れるか**: Claude Code の stream-json 出力パーサ（output-parser.ts 相当）を
  経由するのは claude SDK 経路のみであることは確認したが、**Codex CLI の標準出力から
  トークン usage を実際にパースして `usageData` に反映しているかどうかは、
  静的読解だけでは断定できなかった（Codex 起動部のログ出力・パース処理を今回のスコープでは
  完全には追い切れていない）**。this is a genuine open item — **要実測**。
  `BuildLog` テーブルは exec（teamexec/実行系）専用でトークン列を持たず、
  ask の usage 記録は `Message.usageData` のみが対象。

---

## 8. testflight プロジェクトの適性

`apps/server/src/services/testflight-manager.ts` が `testflight <name>` 実行時に生成するファイル:

| ファイル | 内容 |
|---|---|
| `CLAUDE.md` | ServiceConfig（URL/ポート/DB名/ユーザー/ディレクトリ/ホスティング注記）+ Agreement header/footer（`:273-305`） |
| `rules/devrelay.md` | `DEFAULT_RULES_TEMPLATE`（Agreement 全文、~170行）（`:307`） |
| `rules/project.md` | 「# プロジェクト固有ルール」の空テンプレ（`:308`） |
| `doc/changelog.md` | 「# Changelog」の空テンプレ（`:309`） |
| `.env` | `DATABASE_URL` + `PORT`（`:313-318`） |
| `placeholder/index.html` | Caddy フォールバック用プレースホルダ（`:262-266`） |
| （`--phaser` 指定時）`package.json`/`vite.config.ts`/`tsconfig.json`/`src/**` 等 | `phaser-templates.ts` のゲーム雛形一式 |

- §2-1 で確認した通り、Claude SDK は `settingSources:['project']` により
  **testflight が生成した `CLAUDE.md`（→ `rules/devrelay.md` の Agreement）を必ず読み込む**。
- したがって testflight で作った新規プロジェクトをそのまま席として使うと、
  Agreement 全文が毎コール system prompt に混入する。
  **席用に使うなら `CLAUDE.md`/`rules/devrelay.md` を空または最小限に書き換える必要がある**
  （ただしこれは §9 で述べる根本原因＝`settingSources` 自体を変えない限りの応急処置に過ぎない）。

---

## 9. 副産物として見つかった既存の問題（今回は修正しない・記録のみ）

調査の過程で、本題（raw mode 化）とは独立した既存のバグ／不整合を 2 件発見した。
**承認どおり、本サイクルでは一切修正しない。**

1. **`storageContextPrompt` / `workStatePrompt` が `isEphemeral` でガードされていない**
   - `agents/linux/src/services/connection.ts:1078-1093`:
     `workStatePrompt`（pending work state の注入）と `storageContextPrompt`
     （`loadStorageContext(sessionInfo.projectPath)` の読み込み結果）はいずれも
     `isEphemeral` 判定を経由せず無条件で実行・注入される。
   - 一方で conversation.json / claude-session-id / `.devrelay-output` クリア等、他の状態は
     すべて `isEphemeral` で明示的にガードされている（#348 の意図: 一時セッションは
     対象プロジェクトの永続状態を読み書きしない）ため、この 2 つだけが**その原則から
     外れている**ように見える。
   - 実害の可能性: ask で問い合わせた対象プロジェクトに `pendingWorkState`（auto-continue 用の
     作業状態ファイル）や `storageContext` が存在する場合、**その内容が ask のプロンプトに
     混入し、かつ `workStatePrompt` については `archiveWorkState()` が呼ばれて
     対象プロジェクト側の pending state が消費されてしまう**
     （`connection.ts:1079-1086`: 読み込み後に `archiveWorkState()` を呼びクリアする処理が
     `isEphemeral` 分岐の外にある）。
   - これが意図的な設計か見落としかは、本調査の範囲では断定しない。

2. **`executeCrossProjectQuery()` / `executeCrossProjectExec()` の JSDoc と実装の不一致**
   - `apps/server/src/services/agent-manager.ts:1371`: JSDoc コメント
     `@param timeoutMs タイムアウト（デフォルト 5 分）`
   - 同関数のシグネチャ（`:1382`）: `` timeoutMs: number = 43200000 `` （**12 時間**）
   - `executeCrossProjectExec()` 側（`:1429,1440`）も同様の JSDoc/実装不一致。
   - 実害は小さい（実質的な上限は `ask.sh` の 600 秒 curl タイムアウトで律速されるため）が、
     将来 `ask.sh` 側のタイムアウトを伸ばした場合に「サーバー側は 5 分で切れるはず」という
     誤った前提でハングする可能性がある。

---

## 10. 判定

**不可（現状の ask をそのままゲーム席にはできない）。**

ブロッカーは独立した 2 層があり、どちらも文言・設定変更では解決しない:

### 層 A: プロンプト構造（席の要件に対して過不足がある）
- Agreement・プランモード指示・出力先指示が必ず混入し、個別に無効化する手段がない
- system prompt の完全置換手段が SDK 側には存在するが DevRelay は未配線
- 全ツール無効化の手段がない（`allowedTools: []` は無視されて既定 read-only 一式に戻る）
- 呼び出し単位のモデル指定ができない（UserSettings の plan モデル固定）
- （副産物）storageContext/workState が対象プロジェクトの状態を無断で混入・消費する経路がある

### 層 B: 流量制御（構造的な壁。個別調整では回避不可能）
- ask 同一ターゲット 8回/5分・同時実行 1 件までの制限に対し、
  ゲームのピーク要求（15回/5分・150コール/試合）が正面から抵触する

---

## 11. 最小の追加実装案（1案。本サイクルでは実装しない）

**推奨案: 専用エンドポイント `POST /api/agent/raw-completion` + `raw_` セッション接頭辞の新設**
（`ask` に `raw` フラグを足す案は不採用。理由は §11-3「既存挙動を変えない境界」を参照）

### 11-1. 席側の要件と、それを満たすための対応・影響ファイル・概算行数

| 要件 | 対応方針 | 影響ファイル | 概算行数 |
|---|---|---|---|
| ステートレス（毎回まっさら） | 新設セッション ID を `raw_<uuid>` にし `isEphemeralSession()` の判定対象に追加。既存の ephemeral ガード群（history/resume/conversation.json/`.devrelay-output`/plan file/storageContext/workState）をそのまま全部無効化対象にする | `agents/{linux,macos,windows}/src/services/session-scope.ts`（`isEphemeralSession()` のプレフィックス判定に `raw_` を追加） | 各 +2〜3 |
| ツール全無効 | `ai-runner.ts` に `rawMode` オプションを追加し、`usePlanMode`/`skipPermissions` 系の既存分岐とは独立した第三の分岐で `sdkOptions.allowedTools = []` を**`length > 0` チェックを経由せず直接代入**する専用コードパスを作る（既存の「空配列は無視」の挙動には触れない） | `agents/{linux,macos,windows}/src/services/ai-runner.ts` | 各 +30〜40 |
| system prompt 完全置換 | Claude: `sdkOptions.systemPrompt = <呼び出し元指定の文字列>`（`systemPrompt?: string` を新規に使用）を rawMode 時のみ設定。Codex: system prompt 相当のフラグが CLI にあるかは別途実機確認が必要（無ければプロンプト先頭に明示的に埋め込む代替案を rawMode 専用の合成関数で用意） | 同上 ai-runner.ts、Codex 側は新規 `buildRawCodexArgs()` 関数 | +40〜60 |
| 呼び出し単位のモデル指定 | `raw-completion` のリクエストボディに `model?: string` を追加し、`executeRawCompletion()` から `sendPromptToAgent()` の `model` 引数へそのまま渡す（既存 ask の「plan モデル固定」ロジックを通らない専用経路にする） | `apps/server/src/routes/document-api.ts`（新規ハンドラ内）、`apps/server/src/services/agent-manager.ts`（新規 `executeRawCompletion()`） | +20 |
| レート制限を ask と分離 | `raw-completion` 専用の定数・カウント関数を新設（`crossquery_` プレフィックスでカウントしている既存 `countRecentCrossSessions('crossquery_', ...)` とは別に `raw_` 専用でカウント）。値はゲーム要件（15回/5分ピーク・150コール/試合）を踏まえて別途設計 | `apps/server/src/raw-completion-guard.ts`（新規、`cross-query-guard.ts` と同じ「外部 import ゼロの純関数」流儀） | +80〜100 |
| 同時実行は席単位で1 | `raw-completion-guard.ts` に ask と同型の inflight 判定を実装するが、**判定キーを `targetProjectId` 単位ではなく呼び出し元が指定する「席 ID」相当のキー（例: リクエストボディの `seatKey`）単位**にする（1 プロジェクトに複数席を同時に持たせたい場合、ask の「プロジェクト単位で同時1件」では席数分の並列度が出せないため） | 同上 `raw-completion-guard.ts` + `document-api.ts` 新規ハンドラ | 上記に含む |

概算合計: **サーバー側 +140〜160行（新規ファイル1つ含む）、Agent 側（linux/macos/windows 3OS合計）+220〜280行**。

### 11-2. Claude SDK と Codex それぞれでの system prompt 置換・ツール無効化の実現手段

- **Claude SDK**:
  - system prompt 置換: `query()` の `options.systemPrompt`（`string` 型を渡せば preset を使わず完全独自の
    system prompt になる。`sdk.d.ts:1210-1227`）。現状 DevRelay は未設定のため、rawMode 時にのみ
    `sdkOptions.systemPrompt = <呼び出し元指定文字列>` を設定する分岐を追加すれば実現可能（SDK 仕様上、
    追加実装はほぼ「渡すだけ」で完結する）。
  - ツール全無効化: `allowedTools`/`disallowedTools` の代入ロジックを rawMode 専用に分岐させ、
    「空配列なら未設定扱いにする」既存の `length > 0` ガード（`ai-runner.ts:987`）を経由しない
    別コードパスで `sdkOptions.allowedTools = []` を直接代入する。
    さらに `permissionMode` を `'plan'`（read-only 強制）にしておけば、
    仮に `allowedTools` の扱いに漏れがあっても書き込み系は二重に防御される。
- **Codex CLI**:
  - system prompt 置換: DevRelay は現在 `-c` 経由で `sandbox_mode`/`model` のみを渡しており
    （`ai-runner.ts:2108-2123`）、system prompt 相当のフラグを渡していない。
    Codex CLI 自体に `--append-system-prompt` 相当のネイティブフラグがあるかどうかは
    **本調査では確認できておらず実機での `codex exec --help` 確認が必要**。
    フラグが無い場合の代替案: rawMode 専用の合成関数でユーザー指定の system prompt 文字列を
    プロンプト本文の先頭に明示的に埋め込み、既存の `PLAN_MODE_INSTRUCTION`/`OUTPUT_DIR_INSTRUCTION`
    等の連結処理を rawMode では一切通さない（`composeFullPrompt` とは別の
    `composeRawPrompt(systemPrompt, userPrompt)` 関数を新設し、既存関数には触れない）。
  - ツール全無効化: Codex は `sandbox_mode="read-only"` に加え、rawMode 専用の
    `approval_policy` 設定（常に問い合わせなしで拒否、または read-only sandbox のみで完結させる）
    を明示指定する。Codex CLI がツールを個別に allow/deny する仕組みを持つかは
    `codex exec --help` の実機確認が必要（未確認）。

### 11-3. 既存の ask / teamexec / MCP exec の挙動を変えないための境界

- `crossquery_` / `teamexec_` のセッション ID プレフィックスと、それに紐づく既存のレート制限定数
  （`document-api.ts:36-46`）・カウント関数（`countRecentCrossSessions('crossquery_', ...)` /
  `('teamexec_', ...)`）には一切手を加えない。新設する `raw_` は完全に別のプレフィックス・
  別のカウント関数・別の定数を持つ（**ask に `raw` フラグを足す案を不採用にした理由もこれ**:
  既存 `crossquery_` を流用すると、ask のレート制限カウントに raw の呼び出しが混入し、
  ゲームの高頻度呼び出しが通常の ask レート制限を消費してしまい、
  人間が普段使う ask/teamexec の可用性を圧迫する。専用プレフィックス・専用エンドポイントに
  完全分離することで、この相互汚染を構造的に防ぐ）。
- `apps/server/src/services/permission-policy.ts:41-42`（ask=strictReadonly の無条件マッピング）と
  `apps/server/src/services/cross-query-guard.ts` の `decideCrossTarget()` 判定順序
  （テストで固定されている、`cross-query-guard.ts:103` のコメント参照）には触れない。
  rawMode は同ファイルに新規関数を追加する形にとどめ、既存関数のシグネチャ・返り値・
  判定順序は変更しない。
- `agents/*/src/services/ai-runner.ts` の既存 `usePlanMode`（plan）/`skipPermissions`（exec）の
  2 分岐には手を加えず、rawMode は**独立した第三の分岐**として実装する
  （既存の `if (options.usePlanMode) { ... } else { ... }` 構造の外側で
  `if (options.rawMode) { ...; return; }` のように早期に分離するか、
  もしくは `SendPromptOptions` に `rawMode?: boolean` を追加しつつ既存分岐の内部条件文を
  一切書き換えない形にする）。
- MCP 経由の `submit_instruction`/`approve_implementation` 等（`apps/server/src/mcp/tools.ts`）は
  今回のスコープ外であり、rawMode 導入によって MCP 経路の `disableAsk`/`agentScopeId` 等の
  既存パラメータの意味・デフォルト値を変更しない。
- Team allowlist（`checkCrossTargetAllowed()`）は raw-completion にも適用する
  （席として登録する dangou-card 側プロジェクトと testflight プロジェクトを同一 Team に
  登録する運用は ask と同じ手順で成立させる。allowlist ロジック自体の変更は不要）。

---

## まとめ（判定と次アクション）

- 現状の `ask` は**不可**。プロンプト構造・流量制御の両方でゲーム席用途と根本的にミスマッチ。
- 最小実装は「`raw-completion` 専用エンドポイント + `raw_` セッション接頭辞」の新設。
  既存 ask/teamexec/MCP exec のコードパス・定数・判定順序には一切触れずに追加できる設計。
- 未確認事項（要実機確認、本調査のスコープ外）:
  - Codex CLI に system prompt 完全置換・ツール個別 allow/deny 相当のネイティブフラグがあるか
  - Codex 実行時に `Message.usageData` へトークン usage が実際に記録されているか
