# 本家 devrelay（origin/main）のマージと会社独自 DB 変更の TISA 系列化
- 元スレッド: cmwppbgwo00rv1a8v5wzedzql / 作成: 2026-11-21 10:47 / AI: claude

## 目的
- 本家 `https://github.com/murata1215/devrelay`（remote `origin`）の最新 b57e78c を、この会社サーバー（Windows Server、`D:\devrelay`）の main に取り込む。
- 本家で DB 変更の管理方式が変わった（`apps/server/db/changes/` に 4 桁連番の SQL と台帳テーブル `DbChange`）。これに会社独自の DB 変更を載せる。
- 会社独自の DB 変更は、本家の連番を共有しない。`TISA<4桁>` の別系列で管理する（ユーザー指示）。
- 最終的に会社リポジトリ（remote `company`、このマシンの既定 push 先）へ push する。

## 完了したこと
- **事前準備**
  - 未コミットだった #038 を `fca2442` でコミットした（チャットの案件欄の候補を自分の案件だけにする変更、`apps/server/src/routes/usage-api.ts`）。
  - 退避ブランチ `backup/pre-merge-20261121`（ローカルのみ）を作成した。
  - DB を `D:\backup\devrelay_db_20261121_premerge.dump` にバックアップした（`pg_dump -Fc`、204MB、28 テーブル）。
- **マージ**: `git merge origin/main` → マージコミット **`df1c04b`**（main。未 push）。分岐点は 0725217 で、こちらが 10、本家が 32 コミット先行していた。衝突した 19 ファイルは両方の変更を残して解消した。主な判断:
  - `agents/{linux,macos,windows}/src/services/connection.ts`
    - 会社側のターン専用出力フォルダ（`beginOutputTurn` / `collectTurnOutputFiles(outputTurn)`）と、本家の `statePolicy`（`resolveSessionStatePolicy`）を統合した。
    - `outputTurn` は `statePolicy.outputDirInstruction || statePolicy.outputFileCollect` のときだけ作る。resumable/isolated（他ユーザーの ask）では所有者プロジェクトにフォルダを作らない。
    - prune は `statePolicy.outputDirClear && !payload.handoverTurn` のときだけ行う。
    - 添付は `outputTurn && statePolicy.outputFileCollect ? collectTurnOutputFiles(outputTurn) : []` にした。
    - 引継ぎ `n` の注入条件は `!isEphemeralSession(payload.sessionId) && !statePolicy.crossAskScope && !payload.handoverTurn` にした。
    - プロンプトには `handoverPart` と本家の `claudeMdPrompt` の両方を入れる。
    - linux のみ、会社側の `reuseSessionInfo`（WS 再接続時の履歴消失対策）を残し、`statePolicy` も引き継ぐ。
  - `agents/*/src/services/ai-runner.ts`: 会社側の Devin 累計 usage 補正（`saveDevinAtifStepOffset(..., devinAtifCumulativeUsage)`、`loadDevinAtifUsageOffset`）を、本家の `persistProjectState` / `projectStateRead` ガードの内側に入れた。
  - `packages/shared/src/types.ts`
    - `AgentCapability` / `AGENT_CAPABILITIES` に本家の cross-ask 系・`plan-gate-hook` と、会社の `thread-handover` / `thread-handover-make` を併記した。
    - `ConversationExecPayload` 相当に `handoverTurn` と `statePolicy` を両方持たせた。
    - Windows Agent は `raw-completion`・`plan-gate-hook`・`thread-handover` 系を申告しない（`agents/windows/src/services/connection.ts` の filter）。
  - `apps/server/src/services/agent-manager.ts`: `scopeOptions` に `handoverTurn` と `statePolicy` を両方持たせた。
  - `apps/server/src/services/command-parser.ts`: ヘルプは会社側の出し分け版（`getHelpText` の sections 方式）を残し、本家の `askreset` 行を日英両方に足した。
  - `apps/web/src/pages/ChatPage.tsx`: クロスタブ（他人のプロジェクトへの質問）では、案件欄（CaseTagBar）を出さず、`useThreadCase` に null を渡し、案件必須ガードも効かせない。そのスレッドは所有者のもので、案件を付けられないため。
  - `schema.prisma`、CLAUDE.md、`rules/project.md`、`doc/changelog.md`、`doc/devlog/INDEX.md`、`tsconfig.test.json`、`packages/shared/src/index.ts`、`apps/web/src/lib/api.ts` は両方の変更を残した。
- **TISA 系列の新設**（理由: 本家と連番を共有すると、本家が同じ番号を採ったときにマージで衝突するため）
  - `apps/server/db/changes/tisa/` を作った。中身は `INDEX.tsv`、`README.md`、`TISA0001_session_handover.sql`（Session.handover* 6 列）、`TISA0002_usage_cost_aggregation.sql`（Organization.usageSignageToken + unique 索引、Session.usageCase、UserUsageGroup + userId unique）。
  - `apps/server/src/services/db-change-tisa.ts` を新設した。`diffWithTisaChanges` が本家と TISA を別々に突合して結果を合成する。台帳の name が `TISA` で始まるかどうかで振り分け、TISA 側の表示パスは `tisa/…` にする。
  - `apps/server/src/services/db-change-index.ts` は最小限の変更にとどめた（`loadTisaChangeIndexText` を追加し、`computeDbChangeStatus` で合成関数を使う）。`scripts/db-status.ts` は見出しの文言だけ変えた。
  - `apps/server/db/changes/SCHEMA.sha256` は 1 列目だけマージ後の指紋 `4adb3ded32d6a17c` に更新し、2 列目は `0032_db_change_ledger.sql` のまま。
  - テスト `apps/server/tests/db-changes-tisa.test.mjs` を新設した。運用手順は `doc/db-changes-tisa.md`、CLAUDE.md の DB 手順にも注記を追加した。
- **テストの修正**
  - `agents/*/tests/cross-ask-isolation.test.mjs` の G-4 を `collectTurnOutputFiles(outputTurn)` に合わせた。
  - `apps/web/tests/cross-ask-source-guards.test.mjs` の handleSend の検査範囲を 1500 → 2500 文字に広げた。
  - `apps/web/tests/knowledge-source-guards.test.mjs` の ChatPage 行数ピンを 4396 にした。
- **ビルドとテストの結果**: `pnpm build` は成功。
  - server db-changes 304/304、web 1010/1010、shared 172/172。
  - 残る失敗（server 6 件の sites-log-apply / sites-uu-secret、agents の buildTempPath / resolveScopeDir / runRawCodex / buildServicePath / skill 系）は、会社側コミットが触っていないモジュールの Windows 環境依存。
- **DB 適用**（devrelay ロール、所有者で非 superuser）
  - 本家 0028〜0032 → TISA0001・0002 → `zz1_verify.sql` で MISSING 0 行 → baseline 記録、の順に流した。
  - 結果: `pnpm --filter @devrelay/server db:status` = 「未適用: なし ✅」（台帳 33 件 = 本家 31 + TISA 2）。
  - `prisma migrate diff` でも列の不足はない（差分は既知の embedding 列と Notification FK だけ）。
- **反映**
  - ユーザーが `C:\tools\devrelay-build.cmd` → `C:\tools\devrelay-restart.cmd` を実行し、10:43:49 にサーバーが新コードで起動した。
  - `curl --noproxy '*' http://127.0.0.1:3000/health` は `status: ok`、`dbChanges: {state: ok, pending: 0}`。Agent 7 台が再接続し、起動後のエラーログ追記はない。
- **記録**: `doc/changelog.md` に 2026-11-21 の節を追加した。メモリ `C:\Users\Administrator\.claude\projects\d--devrelay\memory\MEMORY.md` に #039 を 1 行、本文を `archive_worklog_2026-11.md` に書いた。

## 未完了・次の一手
1. ユーザーの動作確認を待つ。確認項目は次のとおり。
   - 普通の会話
   - `n make` → 新しいスレッドで `n` / `n 1`
   - 成果物ファイルが届くか
   - 案件欄と Usage 画面
   - Team 画面が開くか（CrossTeam* テーブル）
2. 各 Agent 機で `u` を送ってもらう（自動更新 ON の機体は自動）。接続中の 7 台はまだマージ前の Agent。
3. ユーザーの OK が出たら、`git push` で会社リポジトリ（`company`）の main を df1c04b にする。`backup/pre-merge-20261121` は push しない。
4. push 後、MEMORY.md の Recent Changes に push 済みの 1 行（#040）を追記し、本文は `archive_worklog_2026-11.md` に書く。
5. 本家側の不具合の報告・修正（任意）。`apps/server/db/changes/zz2_mark_baseline_applied.sql` 50〜51 行目の `RAISE EXCEPTION '…' || '…'` は、PL/pgSQL の構文エラーになる。

## 決定事項・制約
- **マージ方式は merge で、rebase はしない。** 会社側 10 コミットは会社リポジトリへ push 済みのため、履歴を書き換えられない。
- **会社独自の DB 変更は TISA 系列にする**（ユーザー指示「連番の共有はやめよう」）。
  - 置き場所は `apps/server/db/changes/tisa/TISA<4桁>_*.sql`。`INDEX.tsv` の no 列は数字 4 桁のみ。
  - 台帳には `name='TISA000N_…sql'`、`no=N` で記録する。台帳の主キーはファイル名なので、本家と衝突しない。
- **本家ファイルの変更は最小にする**（今後のマージの衝突を減らすため）。本家の `INDEX.tsv` と `tests/db-changes.test.mjs` は変更しない。
- **`SCHEMA.sha256` の 2 列目は本家の最大番号のファイル名のまま。** 本家テストが「2 列目 = 本家 INDEX の最大番号行」を要求しているため。schema.prisma は共有なので、本家が schema を変えるたびにこの 1 行は衝突する。そのときは指紋を計算し直す。
- **DB 適用は AI（私）が実行してよい**（ユーザー了承済み）。
  - アプリと同じロール `devrelay` で実行する。superuser では流さない。
  - 本家の SQL は `psql -1 -v ON_ERROR_STOP=1` で実行する。
- **サーバー再起動・IIS 配置・各機の `u` はユーザーが行う**（CLAUDE.md の方針）。
- **push は動作確認の後に行う。** このマシンの `git push` の既定先は company。

## 触ったファイル
- 新規
  - `apps/server/db/changes/tisa/INDEX.tsv`
  - `apps/server/db/changes/tisa/README.md`
  - `apps/server/db/changes/tisa/TISA0001_session_handover.sql`
  - `apps/server/db/changes/tisa/TISA0002_usage_cost_aggregation.sql`
  - `apps/server/src/services/db-change-tisa.ts`
  - `apps/server/tests/db-changes-tisa.test.mjs`
  - `doc/db-changes-tisa.md`
- 変更（衝突の解消と調整）
  - `agents/{linux,macos,windows}/src/services/connection.ts`、`ai-runner.ts`
  - `agents/{linux,macos,windows}/tests/cross-ask-isolation.test.mjs`
  - `apps/server/prisma/schema.prisma`
  - `apps/server/db/changes/SCHEMA.sha256`
  - `apps/server/src/services/db-change-index.ts`
  - `apps/server/src/scripts/db-status.ts`
  - `apps/server/src/services/agent-manager.ts`
  - `apps/server/src/services/command-parser.ts`
  - `apps/server/src/routes/usage-api.ts`（#038）
  - `apps/web/src/pages/ChatPage.tsx`
  - `apps/web/src/lib/api.ts`
  - `apps/web/tsconfig.test.json`
  - `apps/web/tests/knowledge-source-guards.test.mjs`
  - `apps/web/tests/cross-ask-source-guards.test.mjs`
  - `packages/shared/src/types.ts`、`packages/shared/src/index.ts`
  - `CLAUDE.md`、`rules/project.md`、`doc/changelog.md`、`doc/devlog/INDEX.md`
- リポジトリ外
  - `D:\backup\devrelay_db_20261121_premerge.dump`
  - メモリ `C:\Users\Administrator\.claude\projects\d--devrelay\memory\MEMORY.md`、`archive_worklog_2026-11.md`
  - プラン `C:\Users\Administrator\.claude\plans\floating-honking-lightning.md`
- 未追跡の `doc/handover/` は今回の作業と無関係で、コミットしていない。

## 落とし穴
- **psql**: Windows の psql は `"/c/Program Files/PostgreSQL/18/bin/psql"`。
  - `.env` の `DATABASE_URL` は `?schema=…&connection_limit=…` が付いていて psql が受け付けない。`sed 's/?.*$//'` で外して渡す。
  - 日本語メッセージの文字化けを避けるため `PGCLIENTENCODING=UTF8` を付ける。
- **curl**: 社内プロキシを経由してしまうので、`curl --noproxy '*' http://127.0.0.1:3000/health` で確認する。
- **サーバーのログ**: `D:\devrelay\logs\server.out.log` / `server.err.log`（nssm サービス `devrelay-server`。pm2 ではない）。
  - err.log には時刻が無いので、ファイルの mtime と out.log の `Server listening` の time で前後を判断する。
  - P2022（列が無い）は最終書き込みが 10:43:45 で、再起動前の旧プロセスが出したもの。今のサーバーでは出ていない。
- **`npx prisma generate`**: サーバー稼働中はエンジン DLL の rename が EPERM で失敗する。ただしクライアント JS（index.d.ts 等）は更新される。エンジンは同じバージョンなので問題ない。
- **テスト**
  - Windows では `node --test tests/` が失敗するので、`node --test 'tests/**/*.test.mjs'` で実行する。
  - web は先に `npx tsc -p tsconfig.test.json`（dist-test を作る）が必要。
  - `db-changes*.test.mjs` は git の追跡/stage 済みかを検査するので、新規ファイルは `git add` してから流す。
- **本家の `zz2_mark_baseline_applied.sql` は構文エラーで流れない。** 今回は一時コピー（`$TEMP/zz2_fixed.sql`）で該当行を直して流した。リポジトリのファイルは本家のまま。
- **マージ解消でシェルの文字列を使うとき**: バッククォートを含む TS の文字列を bash の二重引用符内の `node -e` に渡すと、コマンド置換で壊れる。quoted heredoc か Edit ツールを使う。
- **ソース検査型のテスト**: 本家テストには文字数窓・行数ピンで検査するものがある（ChatPage の行数 4396、handleSend の検査範囲 2500 文字）。ChatPage を変えると落ちるので、実測値に更新する。

## 未解決の質問
- 動作確認の結果（ユーザー待ち）。問題があれば push 前に直す。
- 本家の `zz2_mark_baseline_applied.sql` の構文エラーを、本家（origin）側で直すか。ユーザーは本家の持ち主でもある（murata1215）。
- 退避ブランチ `backup/pre-merge-20261121` と DB バックアップをいつ消すか。
