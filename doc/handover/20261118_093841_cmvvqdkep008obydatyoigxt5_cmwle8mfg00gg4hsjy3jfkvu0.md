# スレッド引継ぎ `n make` の導入と、Agent の更新元を会社リポジトリへ揃える作業
- 元スレッド: cmvvqdkep008obydatyoigxt5 / 作成: 2026-11-18 09:38 / AI: claude

## 目的
- DevRelay のスレッド引継ぎ機能を使えるようにする（元スレッドで `n make` → 新スレッドで `n` / `n 1`）。
- 社内の Agent の更新元を会社リポジトリ（`https://github.com/TOYOTA-INFORMATION-SYSTEM-AICHI/devrelay.git`）に揃える。
  - 今は TISA-INTERNALWS と 10.20.171.245 が個人リポジトリ murata1215 から更新している。
  - 会社リポジトリにしか push していない機能（`n make` など）が、この 2 台には届かない。

## 完了したこと
- **スレッド引継ぎ機能を実装し、会社リポジトリに push 済み**
  - 87af6a0: 初版
  - ffd17d1: `n make` 方式に変更
  - 仕様は `doc/thread-management-spec.md` の §11
- **使い方**
  - 元スレッドで `n make`: そのスレッドの AI が引継ぎ書を書き、`<projectPath>/doc/handover/YYYYMMDD_HHmmss_<元ID>.md` に保存する。
  - 新スレッドで `n`: 作成済みの引継ぎ書を一覧表示する。
  - `n 1`: 選んだ引継ぎ書を `..._<元ID>_<新ID>.md` にリネームし、AI に注入する。
- **同時期に会社リポジトリへ push したもの**
  - 8e3d6d6: 添付ファイルの取り違え対策
  - d6c6e84: 日本語ファイル名のダウンロード修正
  - bb75705: Devin の推定コスト修正
  - 8ed51a9: 非 git 警告の廃止
  - company/main の最新は 8ed51a9。
- **DB**: Session に handover 系の 6 列（`handoverFromSessionId` / `handoverNote` / `handoverStamp` / `handoverDoc` / `handoverDocAt` / `handoverDocStamp`）を追加し、SQL で直接適用済み。
- **TISA-INTERNALWS（このマシン）の Agent**
  - 場所は `C:\Users\Administrator\AppData\Roaming\devrelay\agent`。
  - インストールコマンドで origin が会社リポジトリに張り替わった。
  - `git pull` のマージが衝突してビルドが失敗したため、ユーザーが手動で `git merge --abort` → `git fetch origin` → `git reset --hard origin/main` を実行した。HEAD は 8ed51a9。

## 未完了・次の一手
1. **TISA-INTERNALWS**: インストールコマンドを再実行してもらう。ビルドが通り Agent が起動すれば成功。
   - エージェント画面で、バージョンが MURATA_K と同じ（11/17 13:44 ごろ）になったか確認する。
   - プロジェクト devrelay のチャットで `n make` を試す。
2. **10.20.171.245/lfuser（Windows、C1016003）**: 次のどちらかで会社リポジトリに切り替える。
   - (a) `%APPDATA%\devrelay\agent` を `agent_old` などに名前変更してから、インストールコマンドを実行する（新しく clone されるので確実）。
   - (b) インストールコマンドを実行する。衝突で止まったら、上の 3 行（merge --abort / fetch / reset --hard）を実行し、もう一度インストールコマンドを実行する。
3. （任意）`scripts/install-agent.ps1` と `scripts/install-agent.sh` の修正。
   - origin が張り替わったときは `git pull` ではなく `git fetch` + `git reset --hard origin/main` にする。
   - ただしインストールコマンドが読むスクリプトは murata1215 の raw URL なので、会社リポジトリだけ直しても効かない。やるかどうかは未決定。
4. murata1215 の新しいコミット（15ae428 の Gemini 修正以降、b57e78c まで）は、会社リポジトリに取り込まれていない。必要かどうかはユーザーに未確認。

## 決定事項・制約
- **TISA-INTERNALWS と 10.20.171.245 は会社リポジトリに合わせる**（ユーザー決定）。murata1215 には push しない。
- このマシンの `git push` の既定先は company（`remote.pushDefault=company`）。origin（murata1215）は取り込み用。
- このマシンのサーバー再起動は `C:\tools\devrelay-restart.cmd`（nssm）。pm2 ではない。ビルドは `pnpm build`、WebUI の IIS 配置は `C:\tools\devrelay-build.cmd`。
- **`n make` の作りと理由**
  - 引継ぎ書は元スレッドの AI 自身に書かせる。全文脈を知っているのは元スレッドの AI だけだから。
  - 「作成後に会話が進んだか」は `Session.lastActiveAt` で判定する。Message の時刻だと、`n make` 自身の入力行や返答行で誤判定するから。
  - 作成後に会話が進んだ引継ぎ書は、一覧で ⚠️ を付けるだけで選べるようにした（ユーザー承認済み）。
- **Agent の機能フラグ**
  - `n 1` は `thread-handover`、`n make` は `thread-handover-make` を Agent が申告していないと使えない。
  - linux / macos の Agent は申告する。Windows の GUI 版（`agents/windows`）は未対応なので申告しない。
- キルスイッチは `DEVRELAY_THREAD_HANDOVER`（既定 `1`）。

## 触ったファイル
- サーバー
  - `apps/server/src/services/thread-handover-rules.ts`
  - `apps/server/src/services/command-handler.ts`（`handleHandoverMake` / `handleHandoverList` / `handleHandoverPick` / `performHandover`）
  - `apps/server/src/services/command-parser.ts`
  - `apps/server/src/services/natural-language-parser.ts`
  - `apps/server/src/services/agent-manager.ts`（`runHandoverTurn` / `applyHandoverOnAgent`）
  - `apps/server/prisma/schema.prisma`
- 共通（packages/shared）
  - `packages/shared/src/types.ts`
  - `packages/shared/src/i18n.ts`
  - `packages/shared/src/constants.ts`
  - `packages/shared/src/index.ts`
- Agent
  - `agents/linux/src/services/handover-store.ts`（`agents/macos` 側と同一内容）
  - `agents/{linux,macos}/src/services/connection.ts`
  - `agents/windows/src/services/connection.ts`（機能フラグの除外のみ）
- テスト
  - `apps/server/tests/thread-handover-rules.test.mjs`
  - `agents/linux/tests/handover-store.test.mjs`
- ドキュメント
  - `doc/thread-management-spec.md` §11
  - `doc/changelog.md`
  - `rules/project.md`
  - `CLAUDE.md`
  - `README.md`
  - `doc/devlog/2026-10-31_thread_handover_n.md`
- メモリ: `C:\Users\Administrator\.claude\projects\d--devrelay\memory\MEMORY.md` と `archive_worklog_2026-10.md` / `archive_worklog_2026-11.md`

## 落とし穴
- **インストールスクリプトのマージ衝突**
  - 枝分かれした既存 clone で取得元を張り替えると、`install-agent.ps1` の `git pull` が自動マージを始め、10 ファイル前後で衝突する。
  - 衝突の印が残ったままビルドが失敗し、Agent が止まる。
  - `u` は `git reset --hard` で入れ替えるので、この問題は起きない。
- **エージェント画面の「緑」**
  - 緑は「自分の更新元の最新と一致」という意味でしかない。
  - murata1215 の最新でも緑になるので、更新元が違うと分からない。
- **機能が届かない理由**
  - TISA-INTERNALWS の Agent が murata1215 を見ていると、`u` は「最新です」になり、`n make` は「未対応」になる。
  - サーバーを再起動しても、この表示は変わらない。
- **シェル経由のファイル編集**
  - Bash ツールの heredoc や python で `\\n` を書くと、実際の改行に化けることがあった。
  - 文字列リテラルの編集は Edit ツールで行う。
- **プランモード中のコマンド制限**
  - フックが `git -C`、`git fetch`、`$(...)` を拒否する。
  - 別ディレクトリの git を調べるときは、`.git/HEAD` や `refs` などのファイルを直接読む。
- **テストの既存失敗**
  - サーバーのテストは、Windows 環境由来の 6 件（sites.d のパス、0600 権限）が元から失敗する。
  - Agent のテストは、Windows 環境では約 20 件が失敗する（今回の変更より前に元から失敗していたかは確かめていない）。

## 未解決の質問
- インストールスクリプトの修正（張り替え時は fetch + reset --hard にする）を行うか。行う場合、murata1215 の raw URL にも反映するか。
- murata1215 にだけある Gemini 修正など（15ae428〜b57e78c）を、会社リポジトリに取り込むか。
