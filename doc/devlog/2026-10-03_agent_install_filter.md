# 2026-10-03 ｜ Agent 新規インストール / `u` 自己更新の pnpm install を --filter で絞る

## 背景

ユーザーから「新規インストール時に Agent と shared の依存だけを入れる」実装依頼。前回の調査
submission（`cmurfdjgu0b2rjhjhjqdo4zux`）で挙がった複数案のうち**案 2 のみ**を実装対象とする、
という明示指定だった。

新規インストール（`scripts/install-agent.sh`/`.ps1`）と自己更新（`u`）は、pnpm ワークスペースの
ルートから **filter なし** の `pnpm install` を実行していた。pnpm は「ワークスペース内で
`pnpm install` を実行すると全プロジェクトの依存を入れる」のが既定動作のため、Agent CLI には
一切関係のない Electron（`agents/windows`）・Prisma・Vite・React（`apps/server`/`apps/web`）まで
毎回ダウンロードされていた。社内プロキシ経由のみ外部に出られる環境では、取得対象が多いほど
そのまま失敗率に直結するため、サイズ削減だけでなくインストール成功率の問題でもあった。

## 実測

`pnpm-lock.yaml` の依存グラフを辿って到達可能パッケージを求め、`node_modules/.pnpm` の実バイト
サイズと対応付けた。

| 対象 | パッケージ数 | 仮想ストア実サイズ |
|---|---|---|
| 全 workspace（変更前） | 1153 | 1073 MiB |
| `agents/linux` + `packages/shared` のみ | 258 (22.4%) | 304 MiB (28.3%) |

Electron・Prisma・Vite は agent+shared のサブセットに含まれないことを確認済み。

## 実装前に確定させた判断（プラン §事前確認）

ユーザー指示に「Plan でまず『filter で入れた機体に filter なし install を走らせると全 workspace
が入り直すか』を確認し、入り直さないなら項目 3（`u` の filter 化）は見送って理由を報告」という
条件分岐があった。プランモードで調査した結果:

- pnpm 公式ドキュメント（`docs/cli/install.md`）に「ワークスペース内で `pnpm install` は全プロジェ
  クトの依存を入れる」と明記されている。pnpm は「前回どの filter で入れたか」を保持しないため、
  **filter なし install を 1 回走らせれば全 workspace が入り直す**。
- したがって「新規インストールだけ filter 化し `u` は filter 化しない」では、初回 `u` で
  Electron/Prisma/Vite が全部入り直し、新規インストールで節約した 769MiB が消える。
  → **項目 3（`u` の filter 化）は見送らず実装する**と判断。

あわせて「全部入りの既存機で filter 付き `u` を実行しても壊れないか」も確認した:

- pnpm の部分インストール（選択 importer が全体と不一致）では prune 対象が「選択 importer だけが
  所有する依存」に限定され、既存の `apps/server`/`apps/web` の `node_modules` は保持される
  （= 制約「既存機のディスク回収はしない」と自然に整合。裏を返すと既存機は縮まない）
- `tsc` は `agents/*`・`packages/shared` が各々宣言する devDependency から解決されるため、
  ワークスペースルートの依存（`typescript` を含まない）には依存しない
- `u` は `git reset --hard` 後に install するため lockfile は常に無改変 → frozen 段は常に通る。
  install 失敗時は既存の `dist/index.js` 存在ゲートが旧 Agent を生かすため「更新不能のまま死ぬ」
  状態にはならない（このゲートには一切手を入れていない）

副産物として、`pnpm rebuild @homebridge/node-pty-prebuilt-multiarch`（`-r` 無し）はワークスペース
ルートで実行するとカレント importer（ルート自身）の依存グラフしか歩かないため、**元から
`agents/linux` 専用の `node-pty` には到達しない no-op** であることも判明した
（`install-agent.ps1` の既存コメント「pnpm rebuild が Windows で conpty.node を配置しない既知
問題」の正体）。この行は今回変更していない。

## 変更内容

- **`scripts/install-agent.sh`**: 既存の `$AGENT_PKG`（Linux は `@devrelay/agent`、macOS は
  `@devrelay/agent-macos`）を使い、frozen 段・フォールバック段の両方に
  `--filter "${AGENT_PKG}..."` を付与
- **`scripts/install-agent.ps1`**: `$AgentPkg`/`$AgentFilter` を新設し、install filter と build
  filter（従来ハードコード）を単一ソース化。3 段フォールバック
  （①lockfile固定+全体 ②lockfile固定なし+全体 ③filter付き）を**全段 filter 付きの 2 段**に変更
  （①lockfile固定+filter ②lockfile固定なし+filter）。旧③は新②と完全に同一コマンドになるため
  統合。失敗時の人間向け切り分けヒントにも filter 付きコマンドを掲載（+ filter が壊れている
  場合の filter なしエスケープハッチを別行で提示）
- **`u`（自己更新）の filter 化**: `agents/{linux,macos}/src/services/connection.ts` の
  Windows（PowerShell）/bash 両経路、1 段目 + リトライ段の計 4 箇所 ×2 機 = 8 箇所を filter 化。
  コマンド文字列の組み立てを新規純関数 `buildPnpmInstallCommand()` に切り出した
  （`agents/linux/src/services/update-script.ts` に追記、`agents/macos/src/services/
  update-script.ts` は新規ファイルで同内容を複製 — linux/macos の `connection.ts` 自体が既に
  全面二重化されている既存方針に合わせた）。**リトライ段でも `--filter` は外さない**設計
  （外すと install 失敗時にだけ全部入りに戻り、新規インストール側の絞り込みが初回 `u` で
  無効化されてしまうため、本件の本質的な要件）
- macOS Agent 内の到達しない win32 分岐（`process.platform === 'win32'` は macOS では常に false）
  も、同分岐の build 行が `@devrelay/agent`（Linux パッケージ名）であることに揃えて
  `WIN32_AGENT_INSTALL_FILTER` を使用
- `agents/windows`、`apps/server`、`apps/web`、prisma、lockfile/package.json/
  `pnpm-workspace.yaml` は無変更。既存機のディスク回収（`rm`/`pnpm store prune`/`git gc`）は導入せず

## テスト

`agents/linux/src/services/update-script.ts` の既存 `isVersionLikeOutput`/
`buildExecutableResolver`/`buildDependencyProbeBlock`/`buildArtifactFreshnessGate` は無変更のまま、
`buildPnpmInstallCommand`/`AGENT_INSTALL_FILTER` のテストを既存ファイルに追記（10 件）。
macOS 用は新規 `agents/macos/tests/update-script.test.mjs`（10 件）。核心の検証は
「retry 段（`frozen: false`）でも `--filter` が残る」「セレクタが必ず `"` で囲まれる
（PowerShell splat operator 誤解釈回避）」。

## 検証

- `pnpm build`: shared/linux/macos/windows/server/web の 6 workspace すべて green
- `node --test tests/`: shared78/78、linux1048/1048（既存1038+新規10）、
  macos612/612+1skip（既存601+1skip+新規10、追記直後の一発実行で既存の
  `conversation-store-scope.test.mjs`/`handle-conversation-clear.test.mjs` が各 1 件 flake
  したが、該当ファイルのみの単独実行・フルスイート再実行の両方でグリーンを確認し、
  本変更と無関係な既存の並列実行由来 flake と判断）
- **`--frozen-lockfile` + `--filter` の組み合わせを `/tmp` スクラッチクローンで実測**（新規インスト
  ール側の既存 filter 付き段は元々 non-frozen のみだったため、本変更唯一の新規組み合わせ）:
  `/opt/devrelay` を `/tmp/devrelay-filter-test` にローカルクローン → `pnpm install --filter
  "@devrelay/agent..." --frozen-lockfile --ignore-scripts` 実行 →
  `Scope: 2 of 7 workspace projects` と出力され選択が正しいことを確認、`Lockfile is up to date`
  （lockfile 無改変、frozen 段が通る）、`node_modules` 332MiB（予測 304MiB 近傍、electron/
  prisma/vite は 0 件）。続けて `pnpm --filter @devrelay/shared build` /
  `pnpm --filter @devrelay/agent build` が成功し、`node agents/linux/dist/index.js` が実際に
  起動することを確認。検証後にスクラッチクローンは削除
- `git diff --stat -- apps/ prisma/ agents/windows/ pnpm-lock.yaml pnpm-workspace.yaml
  '**/package.json'` で本サイクルの変更がこれらに触れていないことを機械的に確認
  （作業ツリーには 2026-10-02 サイクルの未コミット分がそのまま残存しているため、この diff には
  2026-10-02 分の `agents/windows`/`apps/*` の変更が含まれている。今回のコミットではそれらも
  同梱した — 下記「commit 範囲」参照）

## commit 範囲の注意

作業ツリーには 2026-10-02 サイクル（`agents/{linux,macos,windows}/*/ai-runner.ts`・
`session-store.ts`、`apps/server/*`、`apps/web/*`、`packages/shared/*`、`rules/project.md`、
`CLAUDE.md` 等）の未コミット分が残っていた。ユーザーの承認（approvalNote）により、今回は
`git commit -a` 相当で**同梱してコミット**した。本サイクルで新規に変更したファイルは
「変更ファイル」節のとおりで、それ以外（`ai-runner.ts`/`session-store.ts`/`apps/*`/
`packages/shared/*`/`rules/project.md`/`CLAUDE.md`/`doc/changelog.md` の 2026-10-02 分）は
前サイクルの作業であり本サイクルでは内容を変更していない。

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `scripts/install-agent.sh` | install 行（frozen段+フォールバック段）に `--filter "${AGENT_PKG}..."` 追加 |
| `scripts/install-agent.ps1` | `$AgentPkg`/`$AgentFilter` 導入、3段フォールバック→全段filter付き2段、ヒント更新 |
| `agents/linux/src/services/update-script.ts` | `buildPnpmInstallCommand()`/`AGENT_INSTALL_FILTER` 追加（既存 export は無変更） |
| `agents/linux/src/services/connection.ts` | `u` の pnpm install 呼び出し4箇所を filter 化 |
| `agents/linux/tests/update-script.test.mjs` | 新規関数のテスト10件追記（既存31件は無変更） |
| `agents/macos/src/services/update-script.ts` | 新規。linux版と同じ関数 + `WIN32_AGENT_INSTALL_FILTER` |
| `agents/macos/src/services/connection.ts` | `u` の pnpm install 呼び出し3箇所（win32死にコード含む）を filter 化 |
| `agents/macos/tests/update-script.test.mjs` | 新規、10件 |
| `doc/changelog.md` | 本件のエントリを追加 |

## 完了時の状態

- commit/push 実施（2026-10-02 サイクル未コミット分を同梱、本文に明記）
- `apps/server` 無変更のため pm2 restart 不要（ただし2026-10-02分が未restartのまま残っている旨は
  別途ユーザーへ再掲が必要）
- `agents/linux`・`agents/macos` を変更したため各機 `u` 必須。ただし本変更の効果（ディスク削減）
  は「次回以降の新規インストール／次回 `u` 時点で全部入りが filter 付きに切り替わる」ものであり、
  `u` を打った瞬間に既存機のディスクが縮むわけではない
- DB マイグレーション不要、`agents/windows` 無変更

## 人間側の検証手順（提示済み・未実施）

**A. 新規 Windows 環境**:
```powershell
Remove-Item -Recurse -Force "$env:APPDATA\devrelay\agent"   # 任意（クリーン検証時）
Measure-Command { irm https://<社内ドメイン>/install-agent.ps1 | iex }
"{0:N0} MiB" -f ((Get-ChildItem -Recurse -File "$env:APPDATA\devrelay\agent\node_modules" |
  Measure-Object Length -Sum).Sum / 1MB)
Get-ChildItem "$env:APPDATA\devrelay\agent\node_modules\.pnpm" -Directory |
  Where-Object Name -match '^(electron|prisma|@prisma\+|vite|react)@'   # 期待: 0件
```

**B. Linux 新規インストール**:
```bash
rm -rf ~/.devrelay/agent   # 任意
time curl -fsSL https://<社内ドメイン>/install-agent.sh | bash -s -- --token "<トークン>"
du -sh ~/.devrelay/agent/node_modules
ls ~/.devrelay/agent/node_modules/.pnpm | grep -cE '^(electron|prisma|@prisma\+|vite|react)@'  # 期待 0
```

**C. 既存の全部入り機で `u` が壊れないこと**: `u` 送信 →
`~/.devrelay/agent/logs/update.log`（Windows は `%APPDATA%\devrelay\logs\update.log`）で
`pnpm install exit=0`・`agent build exit=0`・`restarting...` を確認 → Agent 再接続・通常往復確認 →
`apps/server`/`apps/web` の `node_modules` が残存していること（既存機のディスク回収をしていない
ことの確認）。

**D. 端末インタフェースモード（`terminalMode`）**: PTY を使うプロジェクトで1往復し非退行確認。
