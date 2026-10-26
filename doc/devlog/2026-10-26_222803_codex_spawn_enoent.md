# codex が `spawn codex ENOENT` で起動しない問題の根治 (2026-10-26)

## 発生

22:12、チャットで AI を codex に切り替えて送信したところ DevRelay が `Error: spawn codex ENOENT`
を返した。ユーザーの初期仮説は「codex の認証切れ」だったが、調査の結果**認証の問題ではなかった**。

## 実測で確定した事実

| 観測 | 結果 |
|---|---|
| `~/.codex/auth.json` | 存在する（2026-10-23 12:28）。`history.jsonl` も同日 → 当時は動いていた |
| codex 本体 | 存在する: `~/.nvm/versions/node/v20.20.0/bin/codex` → `codex-cli 0.163.0`（手で叩くと動作） |
| `command -v codex`（Agent と同じ PATH） | 見つからない |
| 稼働中 Agent (pid 569952) の `PATH` | `~/.devrelay/node/bin`（**存在しないディレクトリ**）が **5 個重複** + システム標準のみ。nvm の bin が無い |
| 稼働中 Agent の実行 node (`/proc/<pid>/exe`) | `/usr/bin/node`（v18.19.1）。**crontab が指定した nvm node v20.20.0 ではない** |
| crontab `@reboot` | `~/.nvm/versions/node/v20.20.0/bin/node .../dist/index.js`（nvm node を絶対パス指定） |
| agent.log | `[codex] exec --help probe failed` → `[codex] Process error: Error: spawn codex ENOENT` (`path: 'codex'`) |

## 真因（2つ）

### 真因A: `u`（自己更新）の nohup 再起動が裸の `node` を使っていた

`connection.ts` の `u` 自己更新・nohup 再起動分岐が `nohup node "${agentIndex}"` と**裸の `node`**
を使っていたため、`u` を 1 回実行した時点で crontab が渡していた nvm node v20.20.0 を失い、
PATH 上の `/usr/bin/node` v18.19.1 で再起動されていた。nvm グローバルに入れた CLI（codex 等）は
`~/.nvm/versions/node/<ver>/bin` にしか無いため、Agent から見えなくなる。自然治癒しない。

### 真因B: 更新スクリプトの PATH 補完先が固定値で、この機体には存在しない

`connection.ts` の `nodeBinDir = ~/.devrelay/node/bin`（Windows ポータブル node 想定）を
`export PATH="${nodeBinDir}:$PATH"` として毎回前置していたが、この機体には存在しない上、
**冪等でなく** `u` のたびに同じ無効パスが積み上がっていた（実測で5個重複。2026-10-18 の
crontab `;;` 増殖事故と同型のバグ）。

### 付随する構造的欠陥（今回は対処せず）

`ai-tool-probe.ts` の実在判定は絶対パスを見つけても使い捨てており、spawn 時は config の
裸コマンド名をそのまま使う。codex/gemini/aider/devin の全経路に触る改修になるため、
今回は候補追加（1-4）のみで止め、本体の配線変更は別サイクルに回した。

## 対応

### Phase 0: 即時復旧（この機体のみ・コード変更なし）
`~/.devrelay/config.yaml` の `aiTools.codex.command` を nvm の絶対パスに変更。
`isPathLikeCommand()` が絶対パスを素通しするため既存コードのまま通る。
`codex exec` を手で1回叩き認証が生きていることを確認（`Hi!` の応答。401 等のエラーなし）。

### Phase 1: 根治（`agents/linux` + `agents/macos`）
- 新設 `node-bin-path.ts`（純関数・外部 import ゼロ、`crontab-fix-rules.ts` と同じ流儀）:
  `prependBinDir(pathValue, dir, sep, exists)` — 存在しない dir は追加せず、既に含まれる dir は
  重複して追加しない（冪等）。
- `index.ts`: 起動時（`loadConfig()` より前）に `dirname(process.execPath)` を PATH へ前置。
  cron/systemd/launchd/`u` 後の nohup のいずれで起動しても、Agent 自身を実行している node の
  bin が常に PATH 上に乗る。
- `connection.ts`: `u` の PATH 補完を `legacyNodeBinDir`（後方互換・存在判定付き）→
  `execNodeBinDir`（`dirname(process.execPath)`、優先）の順に冪等前置。nohup 再起動も
  裸の `node` → `process.execPath`（絶対パス）に変更（真因Aの本体）。
- `ai-tool-presence.ts` の `aiToolFallbackCandidates()` に `execDir` 引数を追加、候補の先頭に
  `${execDir}/${command}` を加える（Windows は `.cmd`）。`ai-tool-probe.ts` から
  `dirname(process.execPath)` を渡す。既存呼び出しは `execDir` 省略で後方互換。

## 変更ファイル
- `agents/{linux,macos}/src/services/node-bin-path.ts`（新規）
- `agents/{linux,macos}/src/index.ts`
- `agents/{linux,macos}/src/services/connection.ts`
- `agents/{linux,macos}/src/services/ai-tool-presence.ts`
- `agents/{linux,macos}/src/services/ai-tool-probe.ts`
- `agents/{linux,macos}/tests/node-bin-path.test.mjs`（新規）
- `agents/linux/tests/ai-tool-presence.test.mjs`（execDir ケース追加）、`agents/macos/tests/ai-tool-presence.test.mjs`（新規、linux と同内容）
- `~/.devrelay/config.yaml`（リポジトリ外・この機体のみ、Phase 0）

`apps/server` / `apps/web` / `packages/shared` / Prisma は無変更。pm2 restart 不要・DB マイグレーション不要。
`agents/linux` `agents/macos` 変更のため codex 利用機は `u` 必須。キルスイッチなし
（PATH 前置は無効化する意味が無く、旧 `~/.devrelay/node/bin` は存在判定付きで残すため既存環境は無変更）。

## 検証
- Phase 0: `codex exec --skip-git-repo-check` 実行で `Hi!` 応答確認（認証生存確認）。config.yaml 絶対パス化。
  Agent 再起動はユーザー実行待ち。
- Phase 1: `pnpm --filter @devrelay/shared build` / `@devrelay/agent build` / `@devrelay/agent-macos build` green。
  `agents/linux` テスト 1149/1149 green（新規 11 件）。`agents/macos` テスト 711 件中 710 pass・既知flake1件
  （`handle-conversation-clear` / `session-store-scope` / `file-handler` のいずれかがランダムに
  `ERR_TEST_FAILURE: Unable to deserialize cloned data`。単体実行でも再現する node:test ランナー側の
  既知の IPC flake で、今回の変更ファイルとは無関係。4回実行して毎回別ファイルで1件だけ発生、
  node-bin-path/ai-tool-presence の新規テストは全回green）。
- commit/push 後、`u` で配布 → `u` を跨いで codex の PATH/spawn が生き残ることを確認予定。
