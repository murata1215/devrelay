# サイクルSB-0: Sandbox 実行（外向き通信制限）の組み込み調査

- 調査時点の HEAD: **`e917b46`**（`test(web): ChatPage.tsx 行数ピンの更新漏れを修正（4439 → 4454）`）
- 本サイクル（SB-0）は read-only 調査のみ。コード変更・commit・devlog は調査時点では未実施。
- 本ファイルはそのサイクルで Plan として提示した内容の全文保存（要約せず、ファイルパス・行番号を保持）。
- 末尾に「人間の決定（2026-11-23）」を追記（SB-0 の直後に docs-only サイクルで追記）。

---

## Context（なぜやるのか）

Windows の Agent で AI ツール（Claude Code / Devin CLI）を「制限された身元」で動かし、
許可した宛先以外へ出られない状態を DevRelay の機能として提供したい。手動検証（2026-11-20〜22、
Windows 実機 2 台）で Windows ファイアウォール（サービス SID 宛の Outbound Block）＋ 仮想アカウント
（`NT SERVICE\<svc>`）＋ 127.0.0.1 の中継プロキシで実現できることは確認済み。本サイクルは
「既存コードのどこをどう変えれば DevRelay の機能として載るか」を確定させる。

---

## ■ 最重要の発見（設計の前提が1つ変わる）

Claude Agent SDK 0.3.282 に **公式オプション `spawnClaudeCodeProcess` が存在する**。

- `sdk.d.ts:2422-2441` — "Custom function to spawn the Claude Code process. **Use this to run Claude Code in VMs, containers, or remote environments.**"
- `sdk.d.ts:9311-9372` — `SpawnOptions = {command, args, cwd, env, signal}` / `SpawnedProcess = {stdin, stdout, killed, exitCode, signalCode?, kill(), on/once/off('exit'|'error')}`（**stderr は不要**）
- `sdk.mjs` 実測 — 既定の `spawnLocalProcess()` と差し替わる分岐はコード中 1 箇所のみ。`sdk.d.ts:2763` にも「`spawnClaudeCodeProcess` が別マシン/コンテナで Claude Code を動かすホストは…」という記述があり、正規の用途。

これにより、人間の案1（実行ファイルを差し替えて stdio を中継）を **自作シム exe なしで、SDK の公式フックとして実装できる**。かつ `canUseTool` / `hooks.PreToolUse` / `disallowedTools` / `permissionMode` / abort は **Agent プロセスに残ったまま**になる。

---

## 1. 調査結果（A〜H）

### A. 既存スイッチ（承認 / ASK）の仕組み

| 項目 | 実体 |
|---|---|
| UI（classic） | `apps/web/src/pages/ChatPage.tsx:4359-4368`（承認＝Skip Permissions）/ `:4369-4378`（ASK＝Disable Ask）/ `:4379-4388`（端末＝terminalMode）。この 3 連の並びに足すことになる |
| ラベル | `apps/web/src/i18n/messages.ts:175-177`（`chat.autoApprove` / `chat.disableAsk` / `chat.terminal`） |
| 状態の持ち方 | **DB が正**。`Machine.skipPermissions` / `Machine.disableAsk`（`apps/server/prisma/schema.prisma:156-157`、**マシン単位**）、`Project.terminalMode`（`:204`、**プロジェクト単位**）。React 側は単なるキャッシュ（`ChatPage.tsx:2276-2281` の `skipPermissionsMap` / `disableAskMap` / `terminalModeMap`）。**localStorage は使っていない** |
| 永続化 | REST。`GET/PUT /api/machines/:id/skip-permissions`（`apps/server/src/routes/api.ts:394-429`）、`.../disable-ask`（`:474-509`）、`GET/PUT /api/projects/:projectId/terminal-mode`（`:731-760`）。WS（web→server）は `web:command` / `web:tool:approval:response` / `web:cross:ask` の 3 種のみでトグルは通らない |
| server→Agent | ①接続時 `server:connect:ack`（`ServerConnectAckPayload`、`packages/shared/src/types.ts:543-559`、送信 `agent-manager.ts:718-734`）②リアルタイム `server:config:update`（`types.ts:562-569`、`pushConfigUpdate()` = `agent-manager.ts:1853-1864`、ping リトライ + `agent:config:ack`）③exec 開始時の再同期 `server:conversation:exec`（`types.ts:619-668`）。**terminalMode だけは①②を使わず、送信時に DB から読んで payload に載せる方式**（`agent-manager.ts:1537-1541` / `2308-2312`） |
| Agent 側 | モジュール変数 + ゲッター（`agents/linux/src/services/connection.ts:163-185`）→ `sendOptions`（`:1928-1960`）→ `ai-runner.ts` で `disallowedTools`（`:1183`）、`canUseTool` の無条件 allow（`:1489-1494`）、PTY の `--dangerously-skip-permissions`（`terminal-runner.ts:297-298`）に反映 |
| Lite | **承認/ASK スイッチは存在しない**（`LiteHeader.tsx:27-48`。1 件ずつの承認カード `LiteApprovalCard.tsx` のみ）。Sandbox も Lite には出さなくて良い |
| 管理者強制の既存手本 | `Organization.aiModelDefaults`（`schema.prisma:49`）+ `OrganizationMember.canOverrideAiSettings`（`:66`）+ 純関数 `decideEffectiveModel()`（`services/org-ai-defaults.ts:110-125`、`user-settings.ts:216-234`）。**組織で既定を強制し管理者が例外を許す唯一の既存パターン**。`skipPermissions`/`disableAsk`/`terminalMode` には強制の仕組みは無い |

**落とし穴**: `server:config:update` に新フィールドを足すとき `connection.ts:657` の ack 条件の `||` 列に追加し忘れると `pendingConfigUpdates` が MAX_CONFIG_RETRIES まで再送し続ける（同箇所にコメントあり）。

### B. Agent の AI ツール起動部分

- AI 起動は `agents/linux/src/services/ai-runner.ts`（4237 行）に集中。`sendPromptToAi()` = `:2316`（実体 `:2334`）。
  Claude は **Agent SDK の `query()`**（`:1681`）、gemini/devin/codex/aider は `spawn()`、terminalMode は PTY（`terminal-runner.ts:310`）。
- `sdkOptions`（`:1142-1160`）: `cwd=projectPath` / `env={...process.env, ...proxyEnv, DEVRELAY*}`（proxy env の組み立ては `:1116-1128`、`config.proxy.url` 由来）/ `settingSources:['user','project']` / `abortController` / 条件付き `pathToClaudeCodeExecutable`（`:1170-1173`）。
- **Plan/Exec ゲートは 100% in-process（ファイル経由の契約がゼロ）**: `hooks.PreToolUse` は SDK に渡す JS クロージャ（`:1258-1354`）、`canUseTool` も同様（plan `:1369` / exec `:1481`）、`disallowedTools`（`:1182-1188`）、`permissionMode`（plan `:1218` / exec `:1477`）、承認往復は `pendingToolApprovals` Map + `resolveToolApproval()`（`:821`,`:1530`）、中断は `activeSdkAborts`（`:4121-4128`）。
- 境界を越える必要があるもの（SDK 経路）: `{command,args,cwd,env}` と stdin/stdout のバイト列、kill、exit code の **6 つだけ**。
  プロンプト・進捗・canUseTool 往復・承認監査・abort・loop guard・`.devrelay-output` 収集・セッション保存は
  すべて Agent 側に残る（＝既存コード無変更）。
- 既存の「プロセス境界をファイルで越えている」前例（Devin 用に流用可）: `/tmp/devrelay-prompt-<sid>.txt`（mode 0600、`:2749-2757`）、ATIF export の tail（`:2708-2710`,`:2402`）、`.devrelay-output/turn_*`、`.devrelay-files/`。

### C. Windows の Agent 実体とセットアップ

- Windows は **`agents/linux` の dist を node で実行**（`agents/windows` は別実装の Electron 版＝スコープ外）。
  チェックアウト先 `%APPDATA%\devrelay\agent`、設定 `%APPDATA%\devrelay\config.yaml`、ログ `%APPDATA%\devrelay\logs\agent.log`。
- インストーラ `scripts/install-agent.ps1`。起動はタスクスケジューラ `ONLOGON` + **`/RL LIMITED`（非管理者）**
  （`:1449-1451`）→ `start-agent.vbs` → `start-agent.cmd` → node。第一候補は Startup フォルダへの `.vbs` コピー。
- `u`（自己更新）は `connection.ts` の Windows buildSteps（`git fetch/reset` → `pnpm install/build` → `wscript.exe` で再起動）。
  **`spawn('wscript.exe')` に env を渡していない**既知の注意点あり（`doc/sdk-executable-runbook.md` §3.2）。
  Windows 分岐には Linux 側にあるロールバックが無い（`connection.ts:3891-3894` 対比 `:3803-3813`。成果物鮮度ゲートで「殺さない」方式のみ）。
- **現状の Windows 側は「管理者権限を一切使わない」設計**: `install-agent.ps1` に `#Requires -RunAsAdministrator` / `Start-Process -Verb RunAs` は不在、`sc.exe`/`New-Service`/`nssm`/`winsw` はリポジトリ全体に不在。シンボリックリンクを避けて `.cmd` を使う理由も「Windows では管理者権限が必要だから」（`ai-runner.ts:4183-4184`）。方針は `doc/HANDOFF_WINDOWS.md:271-274` に明文化。
  → **本機能は「初めて管理者権限を要求する部分」を持ち込むため、Linux 側の既存作法**（`agents/linux/src/cli/commands/setup.ts:129-130` の user/system 2経路、`uninstall.ts:121-138` の「sudo 失敗時はコマンド文字列を印字」、`apps/server/db/changes/README.md:114-115` の「superuser 前提の操作は bootstrap.sql に追い出す」）**に倣い、管理者操作を別スクリプトに完全分離する。**
- 同梱物の配布経路は 4 種: (a) リポジトリ clone 自体（`u` = `git reset --hard` で全機に届く）(b) TS 文字列から生成して配置（`skill-manager.ts:1593-1682`、呼び出しは `connection.ts:542-544`）(c) capability adapter が外部から取得（`capability-sync.ts`）(d) ネットから zip/tar を落として展開（ポータブル Node `install-agent.ps1:432-466`、conpty.node `connection.ts:3753-3781`）。

### D. 許可リストと設定の配布

- 配布フレームは `server:connect:ack` と `server:config:update` の 2 本だけ。`capabilityConfig` は **メモリのみ**（`capability-sync.ts:95`）、`allowedTools` も **メモリのみ**（`connection.ts:523-527`、OS でキーを選択 `agent-manager.ts:710-713`）、**config.yaml に永続化する唯一の例は `projectsDirs`**（`connection.ts:3114-3129` で `saveConfig()`）。
- `capabilityConfig` の検証器は既知キーだけ再構築し未知キーを捨てる（`apps/server/src/services/capability-config-rules.ts:30-86`）。相乗りするなら検証器の改造が必須。
- 許可リストの置き場候補（既存の類似例つき）:
  1. `Machine.domainAllowlist Json?`（`capabilityConfig`/`projectsDirs`/`managementInfo` と同型・**最も既存に沿う**）
  2. `UserSettings` の KV（**Prisma 変更ゼロ**、OS 別配布の仕組みが既にある）
  3. `AgentConfig`（`agents/linux/src/services/config.ts:9-45`。`ProxyConfig.noProxy?: string[]` が既に配列を持っているので型的に自然）
  4. `Organization.allowedIpRanges` と同型の組織単位。
- DB 変更運用: `apps/server/db/changes/`（最新 **0033**、次は **0034**。TISA 系列は `TISA0003`）。SQL + `INDEX.tsv` 1行 + `SCHEMA.sha256` + `schema.prisma` を**同一コミット**、適用は人間の `psql`、`tests/db-changes.test.mjs` が 9 項目を機械チェック（`RAISE ... ||` 禁止、`IF NOT EXISTS` lint、誤爆ガード3段 など）。

### E. 中継プロキシの置き場所

| 案 | 評価 |
|---|---|
| **各 PC ローカル・Agent プロセス内（推奨）** | Agent は常駐・開発者の身元で動く＝制限された身元から**書き換え不能**。拒否した宛先がその場でメモリ上にあり、ターンの進捗・監査にそのまま載せられる（ファイル tail 不要）。常駐物の追加ゼロ。上位プロキシは既存 `config.proxy.url` をそのまま chain できる。弱点: `u` による Agent 再起動でプロキシも落ちる（実行中ターンは既に `u` 保留の対象なので実害小） |
| 各 PC ローカル・別サービス | 常駐物が増え、インストール・更新・死活監視も増える。Agent 内案に対する利点は「Agent 再起動の影響を受けない」だけ |
| DevRelay サーバー側に置く | 許可リスト・記録を一元化できる反面、全機の AI API トラフィックがサーバーを通る（帯域・単一障害点）。HTTPS は CONNECT トンネルなのでサーバー側でも宛先ホスト名しか記録できず**記録の粒度は同じ**。会社プロキシは拠点ごとに違い多段構成が複雑化。サーバーが全機の confused deputy になる。**非推奨** |

→ **ローカル・Agent プロセス内**（127.0.0.1 の CONNECT プロキシ）。サーバーは SB-4 で**許可リストだけ**配る。

### F. 事前確認と fail-closed

実行前に確認する項目（**設定の存在ではなく「実際に効くか」で確認する**＝`rules/project.md` #352 の原則）:

1. OS が win32 / AI が claude / terminalMode が false（構造的に不可能な組み合わせを先に弾く）
2. Agent のビルドが対応している（新 capability `'sandbox-host'` の申告）
3. 名前付きパイプに接続でき、ハンドシェイクのプロトコル版が一致する
4. **ホストが申告する身元（SID / 名前）が期待する仮想アカウントであり、Agent 自身の身元と異なる**
   （LocalSystem 等で動いているサービスに繋がると「制限」どころか権限拡大になるため、ここは必須）
5. **外向き遮断の実測**: ホスト側から「許可外の既知 IP:443」への TCP 接続が**失敗**し、
   中継プロキシへの接続が**成功**すること（ファイアウォールのルール列挙は管理者権限が要るため使わない）
6. プロジェクトフォルダがホストの身元で読み書きできる（プローブファイル）
7. 中継プロキシが起動済みで許可リストを読めている

満たさないとき: **実行しない**。理由を 1 行でチャットに出し（`devin.readonlyUnsupported` 等の既存の
劣化通知と同じ流儀）、監査に残す。**「制限なしで実行してしまう」経路は作らない**。
UI は `Machine.sandboxStatus`（Agent が申告する readiness）を見てスイッチを無効表示＋理由表示。

### G. 監査ログ

- 既存: `ToolApproval`（ツール承認、`status`/`reason`列）、`approval-logger.ts` の JSONL（`~/.devrelay/logs/` または `%APPDATA%\devrelay\approvals\`）、
  `CrossTeamAuditLog`（append-only・FK 無し・action 文字列で種別を分ける既存の汎用監査テーブル）、
  `Message`（ユーザーに見える記録）、`Notification`、`BuildLog`（exec 実行 1 回 = 1 行、`stopReason String?` が「旧 Agent は null」の後方互換カラムの既存パターン）。
- 方針: SB-1 は **① ユーザーに見える記録 = `Message`**（拒否理由・ブロックした宛先の要約行）＋
  **② 機械的記録 = Agent 側 JSONL**（`approval-logger.ts` と同じ作り）。
  SB-4 で中央集約が必要になったら `CrossTeamAuditLog` と同型の `SandboxAuditLog`
  （action: `enabled` / `denied` / `proxy_blocked`）を新設する。**SB-1 では監査用の DB 変更を作らない**。

### H. プロジェクトごとの前提（6(a)(b)(c)）

| 前提 | 誰が・いつ | 自動化 |
|---|---|---|
| (a) 置き場所（開発者ホーム配下は Claude Code が sensitive file 誤判定） | 人間がリポジトリを `C:\dev\...` 等へ置く | **判定は自動化できる**（`projectPath` が `%USERPROFILE%` / `%APPDATA%` 配下なら Sandbox ON を拒否して理由表示）。移動は人間 |
| (b) フォルダ権限 `icacls ... /grant "NT SERVICE\<svc>:(OI)(CI)M"` | 対象フォルダの所有者である開発者自身 → **管理者権限は不要** | 自動化可。ただし「Agent が黙って ACL を広げる」のは避け、明示コマンド（例 `sandbox prep`）で実行し記録する |
| (c) `git config --global --add safe.directory <path>`（身元ごと） | サービスの身元で実行する必要がある | **ホストサービス経由で `git` を 1 回起動するだけで自動化できる**（新 IPC 不要） |

---

## 2. 推奨する構成

```
[WebUI] Sandbox トグル（プロジェクト単位）
   └ REST → Project.sandbox（DB）
        └ server: ai:prompt / conversation:exec の payload に載せる（terminalMode と同じ方式）
             └ Agent（開発者の身元・非管理者）
                  ├ 事前確認（F の 1〜7）→ NG なら実行拒否
                  ├ SDK query() … canUseTool / PreToolUse / disallowedTools / abort は**ここに残る**
                  │    └ spawnClaudeCodeProcess → 名前付きパイプ ──┐
                  └ 中継 CONNECT プロキシ（127.0.0.1、許可リスト判定）│
                                                                    ↓
        [Sandbox Host サービス（NT SERVICE\devrelay-sandbox）]
             └ claude.exe を自分の身元で起動し stdin/stdout をパイプで中継
                  （Outbound は SID 宛ファイアウォールで 127.0.0.0/8 と DevRelay サーバー以外 Block）
```

**なぜこれか**
- 人間の案1（実行ファイル差し替え + stdio 中継）の正当版。SDK が公式に用意した
  `spawnClaudeCodeProcess` を使うため、**シム exe を自作して SDK を騙す必要がない**。
- 境界を越えるのは `{command,args,cwd,env}` + stdio + kill + exit code の 6 つだけ。
  **Plan/Exec ゲート（PreToolUse / canUseTool / disallowedTools / permissionMode / strictReadonly /
  クロス ask スコープ）は 1 行も移動せず、現状と同一のコードが同一プロセスで動く＝弱まらない。**
- 採らなかった案:
  - **案2（起動処理ごとサービス側へ移す）**: ゲート（in-process クロージャ）と承認往復・abort・
    進捗・loop guard を全部 IPC 化する大改造になる。さらに**ゲートの判定コードが AI と同じ身元で動く**
    ため、その身元が書き換え可能なら「AI が自分のゲートを緩められる」構造になる（読み取り専用配置で
    回避はできるが、わざわざ守るものを増やす）。却下。
  - **自作シム exe で `pathToClaudeCodeExecutable` を差し替える**: 公式フックがあるので不要。
    かつ SDK はネイティブバイナリを直接 spawn する（`.cmd` は shell なしでは起動不可）ため、
    シムは実行可能形式で用意する必要があり配布コストが高い。却下。
  - **DevRelay サーバー側プロキシ**: E の表のとおり却下。
- 身元の切り替えに常駐サービスが必要なのは Windows の仕様上避けられない（仮想アカウントはパスワードが
  無く `CreateProcessWithLogonW` 不可、`CreateProcessAsUser` は管理者権限が必要。
  **既に当該身元で動いているプロセスの子にする以外の方法が無い**）。人間の検証 3 と同じ結論。

---

## 3. 段階分け

### SB-1（最小の縦切り・Windows + Claude Code のみ・セットアップ済み PC 前提）

**ゴール**: Sandbox ON のプロジェクトで 1 往復でき、許可外の宛先への通信が失敗し、
前提が欠けていれば**制限なしで実行せず拒否**される。

| 範囲 | 変更 |
|---|---|
| prisma | `Project.sandbox Boolean @default(false)`（`schema.prisma:204` 付近）+ `db/changes/0034_project_sandbox.sql` + `INDEX.tsv` 1 行 + `SCHEMA.sha256`（同一コミット） |
| shared | `AgentCapability` に `'sandbox-host'` 追加（`types.ts:57,60` + JSDoc）、`AiPromptPayload` / `ConversationExecPayload` に `sandbox?: boolean`、`agent:connect` に `sandboxStatus?`（readiness）型 |
| server | `GET/PUT /api/projects/:id/sandbox`（`routes/api.ts:731-760` の terminal-mode をコピー）、`agent-manager.ts:1537-1541`/`2308-2312` の project select と送信 payload に追加、**fail-closed 判定**（sandbox 要求かつ（capability 未申告 or readiness NG）なら送らずチャットにエラー）、`Machine.sandboxStatus` は Json カラムではなくメモリ保持（`agentCapabilities` と同じ `Map`）で十分 → DB 変更は 1 本のみ |
| agent（`agents/linux` のみ） | 新規 `sandbox-frames.ts`（外部 import ゼロの純関数。フレーム符号化・許可リスト判定・readiness 判定）、新規 `sandbox-launcher.ts`（パイプ接続 + `SpawnedProcess` 実装 + ハンドシェイク検証 + 遮断プローブ）、新規 `sandbox-proxy.ts`（127.0.0.1 の CONNECT プロキシ、上位は `config.proxy.url`）、`ai-runner.ts` の `sdkOptions` に `spawnClaudeCodeProcess` と sandbox 用 env を条件付きで設定（約 30 行）、`connection.ts` で `sandbox` を `sendOptions` に流す、`config.yaml` に `sandbox:` セクション |
| sandbox host（新規ディレクトリ `agents/sandbox-host/`） | `SandboxHost.cs`（1 ファイル・名前付きパイプサーバ + 子プロセス起動 + stdio 中継。shell を使わない・任意身元への昇格機能を持たない）、`scripts/install-sandbox-host.ps1`（管理者: in-box `csc.exe` でビルド → `sc create` → `sc config obj= "NT SERVICE\..."` → ファイアウォールのルール作成 → 許可リストを `C:\ProgramData\devrelay\sandbox\` に配置し**サービス身元には読み取りのみ**付与）、`uninstall-sandbox-host.ps1` |
| web | ChatPage の 3 連トグルの隣に 4 つ目（`terminalMode` と同形・プロジェクト単位）、`messages.ts` に `chat.sandbox`、readiness NG のときは無効表示 + `title` に理由 |
| 対象外 | `agents/macos` / `agents/windows`（Electron）/ Lite / Devin / codex / gemini / terminalMode |

- **pm2 restart**: 要（server 変更 + DB 適用）。**`u`**: 要（対象 Windows 機）。加えて**人間が管理者で
  `install-sandbox-host.ps1` を 1 回実行**。
- **テスト方針**（Linux の CI で green にできる形にする）
  - 純関数: フレーム符号化/復号、許可リスト判定（ホスト名・ワイルドカード・ポート）、readiness 判定の
    fail-closed 表（`cross-ask-isolation-rules.ts` の表駆動テストが雛形）
  - ランチャ: Linux の unix domain socket で偽ホストを立て、`SpawnedProcess` 契約（stdout 中継・kill・
    exit コード・ハンドシェイク不一致で拒否）を検証
  - プロキシ: `node:http` で CONNECT の allow/deny と上位プロキシ chain を検証
  - サーバー: capability 未申告・readiness NG で送信しないことを検証（`ask-guard.test.mjs` が雛形）
  - `C#` は人間の E2E でのみ検証（CI 対象外）
- **人間側 E2E 手順**
  1. 管理者 PowerShell で `install-sandbox-host.ps1`（サービス作成・ルール作成・許可リスト配置）
  2. `icacls C:\dev\<repo> /grant "NT SERVICE\devrelay-sandbox:(OI)(CI)M"`、`sandbox prep`（or 手動 `safe.directory`）
  3. 対象プロジェクトで Sandbox を ON → 普通の質問を 1 回 → 回答が返る
  4. AI に「許可外のドメインへ `curl`」を試させ、**失敗する**ことと拒否行が出ることを確認
  5. `sc stop devrelay-sandbox` → 同じ質問 → **制限なしで動かず拒否される**（fail-closed）
  6. サービスを LocalSystem に書き換えて起動 → **身元検証で拒否される**（F-4）
  7. 事後: `claude.exe` の実体（`%APPDATA%\devrelay\agent\node_modules\...`）をサービス身元が
     読めているか、読めない場合は専用の claude を `C:\dev\tools\` に置く判断

### SB-2 — 運用の磨き
前提自動化（置き場所の自動判定・`icacls` と `safe.directory` の `sandbox prep` コマンド化）、
拒否宛先のターン内可視化と JSONL 監査、ホストのプロトコル版不一致時の案内、
`u` 後のバージョン skew 検出、`agents/macos` への no-op 反映（必要なら）。

### SB-3 — Devin CLI / 他 CLI
`spawn()` 経路を共通の「プロセス起動シーム」に寄せ、Devin（`--prompt-file` の受け渡しディレクトリの
ACL 設計・`credentials.toml` の配置）/ codex / gemini を順に対応。`stderr` の中継をフレームに追加。

### SB-4 — 中央管理
`Machine.sandboxConfig Json?`（許可リスト・プロキシ設定）を `server:connect:ack` / `server:config:update`
に相乗りさせて配布（`capabilityConfig` と同じ経路・同一ホスト名一括適用）。
`Organization.sandboxPolicy` + `OrganizationMember.canOverrideAiSettings` + 純関数
`decideEffectiveSandbox()` で**管理者による強制 ON**（`decideEffectiveModel()` と同型）。
必要なら `SandboxAuditLog` を新設。

### SB-5 — 範囲拡大
Linux/macOS 相当（別方式: 専用 OS ユーザー + nftables/pf。本サイクルのスコープ外）、
terminalMode（PTY）対応の可否判断、`agents/windows`（Electron）対応。

---

## 4. 既存のゲート・スレッド管理への影響

- **Plan/Exec ゲート**: 影響なし（§2 のとおり判定コードは Agent プロセスに残る）。
  `strictReadonly` / `permissionPolicy` / クロス ask スコープ / `plan-gate-hook` capability の意味も不変。
  Sandbox は「ネットワークの封じ込め」で、ツール許可の封じ込め（既存）とは直交する別レイヤ。
- **セッション再開（resume）**: サービス身元の HOME は `C:\WINDOWS\ServiceProfiles\<svc>` になるため、
  Claude のトランスクリプト（`~/.claude/projects/<hash>/...`）が開発者身元のものと別物になる。
  → **Sandbox の ON/OFF が切り替わったスレッドでは resume せず新規セッションにする**必要がある
  （既存の `devin-permission-mode` 保存・不一致検出（`session-store.ts:414`）と同じ作りで
  `session-meta` に sandbox 状態を持たせ、不一致なら新規化 + 会話履歴注入にフォールバック）。
- **ユーザー層の設定が別になる**: `settingSources:['user','project']` の `user` 層、`~/.agents/skills`、
  user scope の Claude plugin（Capability 配布基盤が `--scope user` で入れている分）、user の CLAUDE.md が
  サービス身元からは見えない。**Capability 配布と Sandbox は現状かみ合わない**（SB-3 以降の課題として明記）。
- **スレッド管理**: スレッド単位の設定は増やさない（プロジェクト単位）。`n`（引継ぎ）・`clear` への影響なし。
- `.devrelay-output` 収集・添付（`.devrelay-files`）: ファイル経由のまま。AI が作ったファイルの所有者が
  変わるが、プロジェクトフォルダは開発者が Full のため読める（前サイクルの再帰収集修正とも整合）。

---

## 5. リスク

1. **これは「外向き通信の封じ込め」であって完全な分離ではない**。サンドボックス身元はプロジェクト
   フォルダに書き込めるため、後で開発者身元で `pnpm build` 等を走らせれば制限外のコードが動く
   （今日は AI 自体が開発者身元なので退行ではないが、「安全になった」と誤解させないこと）。
2. サービスが LocalSystem 等で作られていると**権限拡大**になる。F-4 の身元検証を必ず入れる。
3. ファイアウォールのルール列挙は管理者権限が要るため、readiness は**実通信プローブ**で確認する
   （プローブは TTL 付きでキャッシュし、毎ターンの遅延を避ける）。
4. IPv6 全ブロックのため、CLI が `::1` 経由でプロキシに繋ごうとすると無言のハングになりうる。
   プロキシは `127.0.0.1` リテラルで渡し、必要なら `::1` を明示許可する。
5. ホストサービスは `u`（git pull）で更新されないため、フレーム protocol 版の skew が起こる。
   ハンドシェイクで版を照合し、不一致は fail-closed + 更新案内。
6. サンドボックス身元の claude ログイン（`CLAUDE_CODE_OAUTH_TOKEN` or 資格情報コピー）の寿命管理。
7. `claude.exe`（約 230MB・開発者の `%APPDATA%` 配下）をサービス身元が読めるかは実機確認が必要。
8. 名前付きパイプの ACL。サンドボックスの子プロセス自身もパイプに繋げる（同一身元なので権限拡大には
   ならないが、ホストは「自分の身元で起動する」以外の機能を持たせないこと）。
9. 中継プロキシが Agent 内にあるため、`u` による Agent 再起動でターンが切れる（既存の busy ガードで緩和）。

---

## 6. 未決事項（人間が決めること・SB-0 Plan 時点）

1. Sandbox スイッチの単位: プロジェクト単位（推奨・`terminalMode` 方式） / マシン単位（`skipPermissions` 方式）。
2. サービスの構成: 1 台に 1 サービス（全プロジェクト共用）/ 開発者ごと・プロジェクトごとに分ける。
3. ホストサービスの配布: C# ソースを同梱して `csc.exe`（Windows 同梱）でインストール時ビルド（推奨）/
   ビルド済み exe をリポジトリにコミット / NSSM + node 版ホスト。
4. 中継プロキシ: Agent プロセス内（推奨）/ 別常駐サービス。
5. 許可リストの初期値と編集者（SB-1 はローカルファイル。会社環境では git / github.com・社内 Nexus 等も要る）。
6. サンドボックス身元の claude ログイン方式（env トークン / 資格情報コピー）と更新手順。
7. 置き場所が条件を満たさないプロジェクトで ON された場合: 拒否（推奨） / 警告のみ。
8. Sandbox ON で `git push` を許すか（github.com 許可 + サービス身元の資格情報が必要）。
9. Sandbox ON かつ AI が claude 以外（devin/gemini/codex）または terminalMode: 拒否（推奨）。
10. ターンごとの Sandbox 状態を DB に残すか（SB-1 は残さない方針）。

（上記 1〜10 への人間の決定は下記「人間の決定（2026-11-23）」節を参照）

---

## 7. 検証（SB-1 実装後に人間が確かめること・SB-0 Plan 時点）

- `pnpm build` green（既存テスト全件 + 新規純関数テスト）、`node --test apps/server/tests/db-changes.test.mjs` green
- `psql` で 0034 を適用 → `information_schema.columns` で `Project.sandbox` の存在を確認
- `pm2 restart devrelay-server`、対象 Windows 機で `u`
- 上記 §3 SB-1 の E2E 手順 1〜7
- Sandbox OFF のプロジェクト・Linux/macOS 機・Lite・クロス ask が**何も変わらない**ことの確認（退行チェック）

---

## 人間の決定（2026-11-23）

SB-0 の Plan（上記 §6 未決事項 1〜10、および段階分け §3）に対する人間の決定を以下に記録する。
この決定は SB-1 以降の Plan フェーズを拘束する（実装自体は本サイクルでは行わない。本サイクルは
ドキュメントのみ）。

- **段階の順番**: Plan どおり（SB-1 Claude → SB-2 運用の磨き → SB-3 Devin → SB-4 → SB-5）
- **スイッチの単位**: プロジェクト単位（`terminalMode` 方式）
- **サービスの構成**: PC 1 台に 1 つ、全プロジェクト共用
- **ホストの配布**: C# ソース同梱 ＋ インストール時ビルド
- **中継プロキシの置き場所**: Agent プロセス内
- **許可リストの置き場**: Agent の設定（マシン単位）に置き、各開発者が自分のマシンを管理する。
  SB-1 は初期値固定、SB-2 で Agent 設定画面から編集できるようにする
- **claude のログイン方式**: トークン方式（`claude setup-token` で発行したトークンを Agent に登録し、
  起動時に環境変数で渡す。仮想アカウント側には保存しない）
- **git push**: SB-1 では仕組みを入れない（AI はコミットまで、push は開発者が自分の身元で行う）
- **拒否方針**: 置き場所が条件を満たさないプロジェクト、claude 以外のツール、端末モードで ON にされた
  場合は拒否（Plan §6 の 7・9 を確定）
- **DB**: ターンごとの Sandbox 状態は SB-1 では DB に残さない（Plan §6 の 10 を確定）
- **管理者による強制 ON**: SB-4 で対応（Plan §6 の未記載分を確定。SB-1〜SB-3 では強制の仕組みを作らない）
- **前サイクルの未コミット分**: SB-0 の調査時点（HEAD `e917b46`）で作業ツリーに残っていた前サイクル
  2 件（.devrelay-output サブフォルダ再帰収集、Pulse タブ増殖根治）は、本ドキュメント作成に先行する
  サイクル SB-0.1 でコミット・push 済み（`899d656`, `daf3e24`）
- **未決のまま持ち越す事項**: claude 本体（開発者の `%APPDATA%` 配下、約 230MB）を仮想アカウントから
  読めるようにする方法。手動検証では、仮想アカウントは開発者のホーム配下を権限なしでは読めなかった
  （Plan §5 リスク 7 と同一の論点）。SB-1 の Plan フェーズで、以下のような選択肢を比較して決める:
  - 開発者ホーム配下の `claude` 実行ファイルに対してサンドボックス身元へ明示的な読み取り ACL
    （`icacls ... /grant "NT SERVICE\<svc>:(RX)"`）を個別に付与する
  - サンドボックス専用の `claude` 実行ファイルを、開発者ホーム外（例 `C:\ProgramData\devrelay\sandbox\claude\`）
    に別途配置し、サンドボックス身元はそちらだけを読む
  - その他、SB-1 着手時点の実機検証で判明する方法
