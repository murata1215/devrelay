# `u force` 後に Agent が起動せず会話不能になった障害 (2026-10-26)

## 発生

22:34、codex 根治コミット（fd95657）を配布するため x220-158-18-103 の devrelay ユーザーで `u force` を実行。
`🔄 u force: 今すぐ更新を実行します（e5983db → fd95657）` の後、Agent が再接続しなくなった。
チャットで送ったメッセージには `⚠️ エージェントに接続されていないため停止要求を送れませんでした` や
`⛔ 停止できていません（再試行）` が返り、会話できない状態になった。

## 実測で確定した事実

| 観測 | 結果 |
|---|---|
| devrelay ユーザーの Agent プロセス | **存在しない**（他ユーザーの Agent は稼働） |
| agent.log 末尾 | `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/services/crontab-fix-rules.js' imported from .../dist/services/connection.js` |
| update.log | `src/services/connection.ts(46,40): error TS2307: Cannot find module './crontab-fix-rules.js'` → `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` → **`agent build exit=0`** → `restarting...` |
| `/opt/devrelay`（開発リポジトリ） | `agents/linux/src/services/crontab-fix-rules.ts` が **未追跡（`??`）** のまま |
| fd95657 の `connection.ts` | `import { buildFixCrontabCommand } from './crontab-fix-rules.js'` を含む |

## 真因（3つの穴が重なった）

### 1. 未コミットファイルに依存するコミットを push した

`/opt/devrelay` には前サイクルの未コミット WIP（2026-10-18 crontab `;;` 増殖事故の修正一式など）が残っていた。
`connection.ts` の WIP 変更（`crontab-fix-rules.ts` の import）が fd95657 に一緒に入ったが、
import 先の `crontab-fix-rules.ts` は未追跡だったためコミットされなかった。
開発リポジトリではファイルが手元にあるのでビルドもテストも green になり、気付けなかった。

### 2. 更新スクリプトがビルド失敗を常に `exit=0` と記録していた

`connection.ts` の `runAndLog` は次のような形だった。

```bash
pnpm --filter @devrelay/agent build >> update.log 2>&1; echo "[$(date '+...')] agent build exit=$?" >> update.log
```

同じ echo 内の `$(date ...)` が `$?` より先に評価されるため、`$?` は **date の終了コード（常に 0）** になる。
`rebuild PTY` / `shared build` / `agent build` / `fix crontab` の記録はすべて当てにならない状態だった。

### 3. ビルド結果を判定せず、壊れた dist で再起動していた

再起動前のゲートは `dist/index.js` が存在するかどうかだけだった（#329 Part B）。
tsc は型エラーがあっても JS を出力する（`noEmitOnError` なし）ため、`dist/index.js` は存在し、ゲートを素通りした。
旧 Agent が kill された後、壊れた dist で起動して `ERR_MODULE_NOT_FOUND` で即死した。

## 対応

### 即時復旧（この機体）

1. `/opt/devrelay` の `crontab-fix-rules.ts` を `~/.devrelay/agent/agents/linux/src/services/` にコピーして `pnpm build`。
2. crontab と同じ nvm node（v20.20.0）で nohup 起動。サーバー接続と `Claude auth status changed: ok` を確認した。

### 2ecc2ed: 漏れたファイルを追加

`crontab-fix-rules.ts` とテスト `crontab-fix-rules.test.mjs` の 2 ファイルだけをコミットした。他の WIP には触っていない。
push 前に、HEAD を別 worktree に展開してこの 2 ファイルだけを足し、クリーンにビルドが通ること（テスト 7/7 green）を確認した。
**main が壊れていた 22:29（fd95657）〜22:39（2ecc2ed）の間に `u` した機体は、同じ症状で停止している可能性がある。**

### aab5fb4: 更新スクリプトのビルド失敗検出（`agents/linux` + `agents/macos`）

新設 `update-script-rules.ts`（純関数・外部 import ゼロ、linux/macos 同一）に bash 断片の組み立てを切り出した。

- `buildRunAndLog`: 終了コードを `RC=$?` で退避してから記録する（穴 2 の修正）。`runAndLog` / `runAndLogChecked` はこれに委譲。
- `buildCheckedBuildSteps`: shared / agent ビルドを順に実行し、失敗したら `BUILD_OK=0` にして後続を実行しない。
- `buildRecordPrevHead`: `git reset` の前に更新前のコミットを `PREV_HEAD` に記録する。
- `buildRollbackOnBuildFailure`: ビルド失敗時は `PREV_HEAD` に `git reset --hard` して `pnpm install` → 再ビルドし、
  dist を稼働中の旧 Agent のコードに戻す（戻さないと次回の `@reboot` で壊れた dist が起動するため）。
- `buildRestartGate`: `BUILD_OK=1` かつ `dist/index.js` がある場合のみ再起動する（穴 3 の修正）。

ビルド失敗時は旧 Agent が kill されずに動き続ける。サーバー側の更新タイムアウト（`agent-manager.ts` の `UPDATE_TIMEOUT` = 5 分）で
チャットに通知が届くので、ユーザーにも失敗が伝わる。Windows（PowerShell 版）は対象外。

## 検証

- 生成した bash 断片を実際に bash で実行するテスト 10 件（`tests/update-script-rules.test.mjs`）。
  失敗コマンドで `exit=3` が記録されること、失敗時に後続ビルドが実行されないこと、再起動しないこと、
  一時 git リポジトリで `PREV_HEAD` に戻して再ビルドすることを確認。
- linux 1159/1159、macOS 722 件中 721 pass・失敗 0（1 件 skip）。
- HEAD + 今回の 6 ファイルだけを別 worktree に展開しても、linux / macOS ともビルドが通ることを確認。
  worktree でのテストでは `file-handler.test.mjs` が既知の node:test IPC flake（`Unable to deserialize cloned data`）で 1 件落ちたが、今回の変更とは無関係。

## 運用上の注意

- 各機 `u` 必須。ただしその `u` は旧スクリプトで実行されるため、新しい失敗検出が効くのは **次回の `u` から**。
- 新ロジックでは、ビルド失敗時に `hasUpdate` は true のまま残る（更新前のコミットに戻すため）。原因を直して push すれば次の `u` で解消する。
- Agent のコードをコミットする前に、HEAD を別 worktree に展開してクリーンビルドで確認すること。
  `/opt/devrelay` には未追跡の WIP が常駐しているので、手元ビルドが green でも HEAD 単体で壊れていることがある。
- node v20 の `node --test` は glob を展開しないため、`pnpm test`（`"tests/**/*.test.mjs"`）は
  `Could not find` で失敗する。v20 では `node --test tests/*.test.mjs` とシェル側で展開して実行する。

## 関連

- [2026-10-26_222803_codex_spawn_enoent](2026-10-26_222803_codex_spawn_enoent.md)（fd95657、この障害の発端となったコミット）
- 2026-10-18 crontab `;;` 増殖事故（`crontab-fix-rules.ts` の出自）。経緯は `doc/server_listen_hang_20261018.md` の追記にあるが、この追記は 2026-10-26 時点で未コミットの WIP
