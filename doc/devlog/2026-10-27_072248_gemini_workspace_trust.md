# Gemini のワークスペース信頼を DevRelay 側で付与する（exec の yolo が黙って無効化されていた問題の根治） (2026-10-27)

## 経緯

`gemini-user` 機体の障害調査（3 サイクル連続）の最終局面。前サイクルまでで解消した層:

| # | 層 | 状態 |
|---|---|---|
| 1 | `--approval-mode` を probe 結果を見ずにハードコード | 修正済（`08ed948`） |
| 2 | モデルカタログに死んだ ID 2 件（全ユーザー影響の実バグ） | 修正済（`aa74e34`） |
| 3 | `gemini-user` の gemini CLI が古い | ユーザーが 0.65.0 へ更新済 |
| 4 | 検証コマンドが Node 18 のログインシェルで走っていた | Agent 自体は Node 20 と判明 |
| 5 | probe キャッシュが古い CLI のまま残っていた | Agent 再起動で解消 |
| 6 | **ワークスペース未信頼** | ← 本サイクルの対象 |

Agent 再起動後の再テストで、スクリーンショット添付のエラーが出た:

```
❌ gemini CLI が出力なしで終了しました（exit 55）。
[stderr] Approval mode overridden to "default" because the current folder is not trusted.
         Approval mode overridden to "default" because the current folder is not trusted.
         Gemini CLI is not running in a trusted directory. To proceed, either use --skip-trust,
         set the GEMINI_CLI_TRUST_WORKSPACE=true environment variable, or trust this directory
         in interactive mode.
```

## 調査

このログは同時に**良いニュース**も示していた: `SyntaxError`（Node 18 由来）が消え、
`--approval-mode` が受理されている（"overridden" と言われている＝フラグが渡せている）。
つまり層 4・5 は解消済みで、残るは層 6 だけと確定できた。

重要なのは 1 行目の **`Approval mode overridden to "default"`**。Gemini CLI は
**未信頼ディレクトリでは承認モードを問答無用で `default` に落とす**。つまり:

- plan ターン → exit 55 で即死（今回の症状）
- exec ターン → `--approval-mode yolo` を渡しても**黙って `default` に降格**され、
  `run_shell_command` が誰も答えられない確認待ちになる

後者は、**2026-10-26 サイクル（exec でシェルが実行されない問題の根治）が未信頼ディレクトリでは
最初から無効化されていた**ことを意味する。あのサイクルの元の症状（「シェル実行権限が付与されていない」
と Gemini が言ってスクリプトだけ置いて終了）と完全に一致する。母艦で当時効いて見えたのは、
過去に対話起動して `~/.gemini/trustedFolders.json` に登録済みだったからに過ぎず、
**新規プロジェクトディレクトリでは全マシンで同じ穴が開いていた**。

### 実機で検証（母艦、gemini-cli 0.65.0、未信頼ディレクトリ `/tmp`）

```bash
# 修正前の再現
cd /tmp && gemini --approval-mode plan -p "Reply with exactly: OK"
→ Gemini CLI is not running in a trusted directory ... （失敗）

# 環境変数を足すと解消
cd /tmp && GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode plan -p "Reply with exactly: OK"
→ OK   (exit 0)

# exec 相当（yolo）も降格されなくなる ← ここが本題
cd /tmp && GEMINI_CLI_TRUST_WORKSPACE=true gemini --approval-mode yolo -p "Reply with exactly: OK"
→ YOLO mode is enabled. All tool calls will be automatically approved.
→ OK   (exit 0)
```

DevRelay は Devin に対しては既にこの手当てをしていた（#345 `--respect-workspace-trust false`、
`devin.workspaceUntrusted` の案内つき）。**Gemini にだけ同じ手当てが無かった**のが真因。

## 対応

### Phase 1: spawn env にワークスペース信頼を付与

`agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐の `spawn()` env に
`GEMINI_CLI_TRUST_WORKSPACE: 'true'` を追加。`--skip-trust` フラグではなく**環境変数**を選んだ:

1. 旧 CLI で `Unknown arguments` にならない（未知の環境変数は黙って無視されるだけ）。
   2 サイクル前に `--approval-mode` を無条件に渡して会話不能にした事故を繰り返さない
2. Gemini 自身が headless/automated 環境向けの正式な手段としてエラーメッセージとドキュメント
   （`trusted-folders/#headless-and-automated-environments`）で案内している

DevRelay はユーザーが自分のマシンの自分のプロジェクトを明示的に接続して AI に作業させる前提で、
workspace trust は「対話中にうっかり未知のリポジトリを開く」ことを想定した機構。非対話実行では
誰も信頼プロンプトに答えられず、付与しても安全性は 1mm も上がらない（Devin #345 と同じ判断）。

今回は**セキュリティ既定を変える**変更のため、前 2 サイクル（「戻す意味のある挙動変更が無い」として
キルスイッチ無し）とは違い、キルスイッチ `DEVRELAY_GEMINI_TRUST_WORKSPACE`（既定 `1`、Agent 環境の
env var。`0` で付与しない）を置いた。

### Phase 2: 信頼エラーの診断メッセージ（安全網）

`DEVRELAY_GEMINI_TRUST_WORKSPACE=0` にした場合や環境変数を解さない版の CLI では今回と同じ
生 stderr（ANSI エスケープ混じり）が出る。Devin 側に既にある仕組みを流用:

- `agents/{linux,macos,windows}/src/services/cli-failure.ts` の `isWorkspaceTrustError()`
  （従来は Devin 固有の文言のみ）に Gemini の拒否文言
  （`not running in a trusted directory` / `folder is not trusted`）を追加
- i18n `gemini.workspaceUntrusted` を新設（既存 `devin.workspaceUntrusted` と同じ文面構造）
- `ai-runner.ts` の終了ハンドラに `aiTool === 'gemini' && isWorkspaceTrustError(...)` の分岐を
  Devin の分岐の直後に追加（`classifyCliFailure()` の判定順序は変更しない）

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `agents/{linux,macos,windows}/src/services/ai-runner.ts` | gemini spawn env に `GEMINI_CLI_TRUST_WORKSPACE`、信頼エラー分岐の追加 |
| `agents/{linux,macos,windows}/src/services/cli-failure.ts` | `isWorkspaceTrustError()` に Gemini 文言を追加 |
| `packages/shared/src/i18n.ts` | `gemini.workspaceUntrusted` 追加 |
| `agents/{linux,macos}/tests/cli-failure.test.mjs` | 実機 stderr（スクリーンショット添付のログ）を fixture にしたテスト3件追加（windows は同テストファイル未保有） |
| `rules/project.md` | 「未信頼だと yolo が黙って降格される」発見を 2026-10-26 エントリに追記 |

## 今回やらないこと（次サイクル候補）

- **probe キャッシュの無効化**: `probeGeminiCapabilities()` は Agent プロセス寿命いっぱい
  キャッシュし、CLI を更新しても `u`（最新コミット時は `decideUpdateFlow()` が `upToDate` を返し
  再起動しない）では捨てられない。今回は手動の Agent 再起動が必要になった
- **「この CLI には新しい Node が必要」診断**: 今回の `SyntaxError: Invalid regular expression
  flags`（`/v` フラグは Node 20+ 専用）はユーザーのログインシェル側の事象で Agent は Node 20 だったが、
  2026-10-26 の codex（nvm 環境喪失）と同じ再発クラスではある
- `a` コマンドへの AI CLI / Node バージョン表示

## 検証

- `agents/{linux,macos}/tests/cli-failure.test.mjs`: 22/22 green（既存19 + 新規3、実機 stderr fixture 込み）
- 3 エージェント個別 `npx tsc --noEmit` green
- `pnpm build`（モノレポ全体）green
- 各パッケージ個別実行: shared 121/121・server 1380/1380・web 924/924・linux 1167/1167 green。
  macos・windows は並列実行下で毎回別ファイルが既知の Node test runner IPC flake で落ちたが、
  `--test-concurrency=1` でいずれも全件 green（730/730）、本変更と無関係と確認済み
- 実機（母艦、未信頼ディレクトリ）: `GEMINI_CLI_TRUST_WORKSPACE=true` ありで plan（`--approval-mode
  plan`）・exec 相当（`--approval-mode yolo`）とも "Approval mode overridden" が出ずに成功することを確認

## 反映

`agents/*` のみの変更のため、Gemini を使用する全機体で commit + push 後に `u` が必要。
`apps/server`・`apps/web` のランタイムコードは無変更のため `pm2 restart devrelay-server` は不要。
DB マイグレーションなし。

`gemini-user` 機体は `u` 後、未信頼の新規プロジェクトディレクトリでも plan/exec とも正常に動作する
はず（本サイクルの実機最終確認は人間側実施待ち）。
