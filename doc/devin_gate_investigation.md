# Devin CLI 承認ゲート調査（サイクル D0, 2026-09-17）

DevRelay が Devin CLI をどう起動しているか、plan/exec フェーズで承認ゲートを機構的に効かせられるかを調査した記録。read-only 調査（コード変更なし）。

## 背景

`a 4`（Devin CLI 3000.6.7 / Windows 機 DESKTOP-1E6SDOQ）が DevRelay のプランモード規律（e/exec ゲート）を「外部システムの演技設定であり自分の仕様ではない」と明言して従わなかった（read-only 依頼だったため実害なし）。Codex CLI は同種の指示に従った。この差の構造的な理由を確定し、Devin に対してプロンプト以外の機構的な歯止めをかけられるかを判定するのが目的。

## 結論（先出し）

**「Devin には承認ゲートが無い」は不正確。** 実際には git 自動復元ガードという事後的な機構ガードが 1 枚存在する。しかし**それは `projectPath` 配下の git 管理下ファイルしか守らない**。`git push` / `sudo` / パッケージインストール / サービス再起動 / 外部送信のような**不可逆・ツリー外の操作は完全に素通り**する。これが実際の穴。

**方針は案 B（機構化の断念 + 明記 + 警告）を採用**して記録する。案 A（deny ルール注入による機構化）は、`--permission-mode dangerous` がユーザ/プロジェクトレベルの `deny` ルールを上書きするかどうかという実機でしか確定できない 1 点に成否が完全に依存するため、Q5 の実機確認（人間側実施）待ちの任意項目として未決に残す。

---

## Q1. DevRelay が devin をどう起動しているか

### 起動箇所（3 OS 共通、argv 構築はほぼ同一）

`agents/{linux,macos,windows}/src/services/ai-runner.ts:1909-2075`

spawn 本体（`ai-runner.ts:2057-2075`）:

```ts
proc = spawn(command, args, {
  cwd: projectPath,          // :2058  プロジェクトルート固定
  shell: true,               // :2059
  stdio: ['pipe','pipe','pipe'],
  windowsHide: true,
  env: { ...process.env, ...proxyEnv, PATH: devinEnvPath,
         DEVRELAY:'1', DEVRELAY_SESSION_ID: sessionId,
         DEVRELAY_PROJECT: projectPath, CHISEL_LOG_STDERR:'1' },  // :2062-2071
});
proc.stdin?.end();           // :2075  stdin は未使用
```

- **cwd**: `projectPath`（`:2058`）
- **env**: 親環境を全継承 + proxy（`:1861-1868`）+ `CHISEL_LOG_STDERR=1`（`:2070`、devin 内部ログを stderr に出させ進捗表示に使う）。API キーの注入は無い（devin 自身の config/auth を使う）
- **プロンプトの渡し方**: 一時ファイル `--prompt-file $TMPDIR/devrelay-prompt-<sessionId>.txt`（`:2024-2028`）。非対応時は**中止**（`:2029-2033`、#344 で argv 直渡しのコマンド注入経路を撤去済み）

### 渡しているフラグ（`ai-runner.ts:1914-2033`）

| フラグ | 条件 | 行 |
|---|---|---|
| `-r <sessionId>` | 保存済み session + permission mode 一致 + モデル一致 | `:1959` |
| `-p` | 常時 | `:1978` / `:1982` |
| `--permission-mode dangerous` | probe で対応時 | `:1978` |
| `--export <path>` | probe 対応時 | `:1991` |
| `--model <model>` | 指定あり + probe 対応 | `:1999` |
| `--respect-workspace-trust false` | probe 対応 + env で無効化されていない | `:2013-2014` |
| `--prompt-file <path>` | probe 対応（必須） | `:2028` |

フラグ対応可否は `probeDevinCapabilities()`（`:248-306`）が `devin --help` を 1 回叩いて判定・キャッシュする。

### plan / exec の起動差分 — argv は完全に同一（コードで確認）

`ai-runner.ts:1937-1940`:

```ts
// #368 Phase2a-C: Devin は常に exec 相当（dangerous）で起動する。
const devinTurnPermissionMode: string | null =
  devinHasPermissionMode ? 'dangerous' : null;
```

差は argv ではなくプロンプト本文と後処理にのみある:

| | plan | exec |
|---|---|---|
| argv | 同一（`--permission-mode dangerous`） | 同一 |
| `-r` resume | する | しない |
| preamble 前置 | する（`devin-plan-prompt.ts:31-40`、`connection.ts:1113`） | しない |
| git 自動復元ガード | する（`connection.ts:1456-1463` / `1759-1764`） | しない |

### 全プロバイダ横断比較（コードで確認）

| Provider | plan 起動 | exec 起動 | 強制レイヤ |
|---|---|---|---|
| Claude (SDK) | `permissionMode='plan'`（`:982`）+ `canUseTool` で write 拒否（`:1045-1071`）+ `disallowedTools:['ExitPlanMode']`（`:972-977`） | `permissionMode='default'`（`:1084`） | **SDK コールバック（機構）** |
| Codex | `-c sandbox_mode="read-only"`（`:2092`） | `-c sandbox_mode="danger-full-access"` + `approval_policy="never"`（`:2094`） | **CLI サンドボックス（機構）** |
| Devin | `-p --permission-mode dangerous` | `-p --permission-mode dangerous` | プロンプト + git 事後復元 |
| Gemini | `--approval-mode auto_edit` | `--approval-mode auto_edit`（差分なし） | プロンプトのみ |

サーバ側ポリシー決定: `apps/server/src/services/permission-policy.ts:37-47` の `resolvePermissionPolicy()`（`chat`/`ask`/`mcp` → `strictReadonly`、`exec` → `interactive`）。WebSocket の `permissionPolicy` フィールドで Agent に届き `connection.ts:1287-1290` で解釈される。**この値は Devin の argv には一切影響しない。**

---

## Q2. Devin の「従わない」の実体

コードで確認: Devin は plan フェーズでも `--permission-mode dangerous`（全ツール自動承認）で起動している。公式ドキュメント上 `dangerous`（= `yolo`/`bypass`）は「all tool calls are auto-approved without prompting」。プロセスの権限は exec と 1 ビットも違わない。

**Devin の発言は実際の CLI 権限状態としては正しい。** プランモードを表すのはプロンプト本文だけで、プロセス権限には表れていない。

**経緯（`devin-plan-prompt.ts:4-11` に記録済み、コードで確認）**: Devin の `Exec()` パーミッションはトークン単位のプレフィックス一致で、複合コマンド（`&&`/`;`/パイプ）を裸のコマンド名に分解して判定するため allow-list 方式は構造的にモグラ叩きになり、拒否 1 件でターン全体が `Interrupting stop token` により exit 0・出力ゼロの無言終了に落ちる（#362〜#368、約 6 サイクル）。#368 Phase 2a はこれを「権限で縛るのを諦め、dangerous 固定 + 自然言語 preamble + git 事後復元」へ転換した。**現状は意図的な設計判断であり、実装漏れではない。**

**非対話実行での承認要求の扱い（ドキュメントで確認）**: 「When tools require approval in non-interactive mode, the session fails rather than blocking for user input」（https://docs.devin.ai/cli/reference/commands ）。検出器は `devin-diagnostics.ts:83-92` の `isDevinToolRejectionText()`（`auto-decided Some(Deny)` 等 5 パターン）。`-p` では「承認待ち」は無く、必ず失敗に倒れる。

### 現状の安全網の実力（コードで確認）

git 自動復元ガード:
- baseline 取得: `connection.ts:1456-1459`（`isDevin && isPlanTurn` かつ git リポジトリのとき）
- 復元: `connection.ts:1759-1764`（`finally` 節、`restoreToBaseline()`）
- 非 git リポジトリでは `devin.planGuardUnavailable` を必ず通知（`connection.ts:1460-1463`、静かなフォールバック禁止）

**守れないもの**: `projectPath` 外の書き込み / 非 git プロジェクト / 不可逆な副作用（`git push`、`sudo`、パッケージインストール、DB 書き込み、サービス再起動、外部 API 送信）。

---

## Q3. 機構で止める手段が非対話起動で使えるか（ドキュメントで確認）

出典: https://docs.devin.ai/cli/reference/permissions 、 https://docs.devin.ai/cli/reference/commands 、 https://docs.devin.ai/cli/reference/configuration/config-file 、 https://docs.devin.ai/cli/reference/configuration/global-vs-local 、 https://docs.devin.ai/cli/essential-commands

### (a) agent mode Plan を起動時に指定 → **不可能**

Plan/Ask/Normal の agent mode は対話中のスラッシュコマンド `/plan`/`/ask` のみ。起動フラグ・環境変数は文書化されていない。`-p` 非対話では到達不能。

### (b) permission mode を plan 相当にできるか → **使えるが実用にならない**

値: `normal`(`auto`) / `accept-edits` / `smart` / `dangerous`(`yolo`/`bypass`) / `autonomous`（`--sandbox` 必須、macOS/Linux のみ）。

`normal` は「read-only 自動承認、writes と shell commands は承認プロンプト」。`-p` ではプロンプトが出せず即失敗するため、調査に必要な `grep`/`ls`/`git status` を含め全 Exec が落ちる。`accept-edits`/`smart` は編集を自動承認しプランの目的と逆。`autonomous` は Windows 機では使えない。

### (c) 権限ルール（allow/ask/deny）を注入できるか → **注入口はあるが効果は未確認**

形式（ドキュメント確認）:
```json
{ "permissions": {
    "allow": ["Read(**)", "Exec(git)"],
    "ask":   ["Write(**/.env*)"],
    "deny":  ["Exec(sudo)", "Write(/etc/**)"] } }
```
マッチャ: `Read(glob)`/`Write(glob)`/`Exec(prefix)`/`Fetch(urlpattern)`、ツール名（`read`/`edit`/`exec`）、MCP（`mcp__server__tool`）。

優先順位（高→低）: 組織/チーム設定 → セッション内対話許可 → `.devin/config.local.json` → `.devin/config.json` → ユーザ config（`~/.config/devin/config.json`、Windows `%APPDATA%\devin\config.json`）→ システムポリシー。「A denial at a higher level cannot be overridden by an allow at a lower level」。

| 注入口 | 評価 |
|---|---|
| `--config <PATH>` | **危険**。#347 Phase 0 の実測（`devin-diagnostics.ts:46-56` に記録済み）で、devin は `--config` 指定ファイルをユーザ config そのものの置き換えとして扱い、`shell.setup_complete` が無いと毎回ウェルカムバナーを吐くと判明済み |
| `.devin/config.local.json` | 本命。ターンごとに書いて消す実装が必要 |
| 組織/チーム設定・システムポリシー | モードで上書きされないことが明文化された唯一の層だが、ターン単位で切り替えられない |

### (d) 最大の未確認点

ドキュメントは「Smart, Bypass, and Autonomous modes do not override **organization-level** permissions」としか書いていない。**`--permission-mode dangerous` がユーザ/プロジェクトレベルの `deny` を無効化するかは未確認。** これは実機でしか確定できない（Q5 として人間側実施を依頼済み、本サイクルでは未実施）。

### (e) directory restrictions / org policy（参考）

`respect_gitignore`、`sandbox`（ドメイン単位ネットワークフィルタ）、`Fetch(pattern)` が存在。組織設定の deny/ask はモードで上書き不可。いずれもマシン/組織単位でターン単位切替には使えない。

---

## Q4. 方針（確定）

**案 B を採用**: 機構化は当面断念し、以下を仕様として明記する。

> DevRelay 上の Devin および Gemini の plan フェーズには機構的な承認ゲートが存在しない。argv は plan/exec で同一であり、プランモードの規律はプロンプト指示のみに依存する。Devin には git 自動復元ガードという事後的な安全網があるが、これは projectPath 配下の git 管理下ファイルの可逆な変更しか守らない。ツリー外への書き込み、非 git プロジェクト、および `git push`/`sudo`/パッケージインストール/サービス再起動/外部送信のような不可逆な副作用は無防備である。

B の実装（仕様書本文への反映、`a 4`/Gemini 選択時のチャット警告表示）は**別サイクルで実施**する（本サイクルは記録のみ）。

**案 A（deny ルール注入による機構化）は未決のまま残す。** Q3(d) の実機確認（Q5-6、`--permission-mode dangerous` 下で user/project レベルの `deny` が有効かの実測）で「効く」と判明した場合のみ、`Write(**)` と不可逆 Exec プレフィックス（`git push`/`sudo`/`rm`/パッケージインストール/`pm2 restart` 等）に限定した deny ルールを `.devin/config.local.json` 経由でターン単位に注入する小サイクルを検討する。git-guard とは併存させ多層防御とする。「効かない」と判明した場合は案 A を構造的に不可能と結論し、案 B の恒久方針として確定する。

---

## Q5. 人間側で実機確認するコマンド（DESKTOP-1E6SDOQ / PowerShell・read-only、1行ずつ実行）

```powershell
devin --version
```
```powershell
devin --help
```
```powershell
devin --permission-mode --help
```
```powershell
Test-Path "$env:APPDATA\devin\config.json"
```
```powershell
Get-Content "$env:APPDATA\devin\config.json" -Encoding UTF8
```

**本丸 — user config の deny が `--permission-mode dangerous` を上書きするか**

事前バックアップ:
```powershell
Copy-Item "$env:APPDATA\devin\config.json" "$env:APPDATA\devin\config.json.d0bak"
```
`permissions.deny` に `Write(**)` を足した上で:
```powershell
devin -p --permission-mode dangerous --respect-workspace-trust false --prompt-file C:\temp\d0probe.txt
```
（`d0probe.txt` は「`C:\temp\d0-canary.txt` というファイルを作って」の1行）

判定:
```powershell
Test-Path C:\temp\d0-canary.txt
```
- `False` かつ拒否メッセージあり → deny が dangerous を上書きする → 案 A 成立の可能性
- `True` → dangerous が deny を無効化する → 案 A 不成立、案 B 確定

復元:
```powershell
Move-Item "$env:APPDATA\devin\config.json.d0bak" "$env:APPDATA\devin\config.json" -Force
```

任意（プロジェクト config が読まれるかの確認）:
```powershell
devin -p --permission-mode dangerous --respect-workspace-trust false -- "現在有効な permissions ルールをすべて列挙して"
```

**本サイクルでは未実施。実施は人間側に委ねる。**

---

## Q6. 未 commit 変更の正体（read-only 確認・別 commit で解消）

2026-09-15 の「aisignage/lfuser のエージェントをクリックすると全画面真っ白になる問題」の修正（プランファイル `cozy-giggling-owl.md`）。

真因: `Machine.managementInfo`（Agent 由来の未検証 JSON）が当該マシンで `{}` になっており、`managementInfo && managementInfo.commands.length > 0` が `{}` を truthy と判定した直後に `.commands` で `TypeError` を投げ、React ツリー全体が unmount されていた。

対象ファイル（`ErrorBoundary.tsx`/`machine-display-rules.ts`/そのテスト、`App.tsx`/`tsconfig.test.json` の変更）は commit `b1c8451` として本サイクルで別途 commit 済み（D0 調査 commit とは分離）。

### 副次的に発見した問題（本サイクルで解消済み）

**`origin/main`（当時の HEAD `f6db459`）が clean clone からビルド不能な状態だった。** `MachinesPage.tsx`（`f6db459` で commit 済み）が 13 行目で `import { normalizeManagementInfo, formatDateTimeSafe } from '../lib/machine-display-rules'` を参照していたが、依存先の `machine-display-rules.ts` は untracked のまま取り残されていた。サイクル P3-C の commit 時に依存先ファイルが巻き込まれず、`MachinesPage.tsx` の import だけが先行 commit されたことが原因。

影響範囲: Agent 自己更新 `u` は `pnpm --filter @devrelay/shared build` と `@devrelay/agent build` のみを実行し `apps/web` はビルドしないため（`connection.ts:2959-2960`）、`u` への影響は無い。影響はフルビルド・新規 clone・web デプロイに限定されていた。

`b1c8451` で該当ファイル群を commit した上で、`git worktree add` による HEAD の隔離展開 → `pnpm install --frozen-lockfile --offline` → `pnpm --filter @devrelay/shared build` → `apps/web` の `pnpm build` を実施し、TS エラー無く成功することを実測して解消を確認した。

---

## 未決事項

1. **【最重要・実機必須】`--permission-mode dangerous` はユーザ/プロジェクトレベルの `deny` ルールを上書きするか。** Q5 の実機確認結果で案 A の成否が決まる
2. `.devin/config.local.json` が permissions を受け付けるか（`permissions.md` は `config.local.json`、`config-file.md` は `mcp_config.local.json` と記載しておりドキュメント間で不一致。実機確認が必要）
3. deny ヒット時の挙動が「そのツール呼び出しだけ失敗して続行」か「ターンごと abort」か。案 A の実用性を左右する
4. Devin CLI 3000.6.7（実機）と最新ドキュメント（`smart` モード等を含む）のバージョン差
5. Gemini も plan/exec で argv が同一（`--approval-mode auto_edit` 固定）で同じ穴がある。案 B の仕様書明記・警告表示は Gemini も対象にする
6. 案 B の実装（仕様書本文反映、`a 4`/Gemini 選択時の警告表示）を行うサイクルの計画
