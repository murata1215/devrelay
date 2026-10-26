# 「未コミットファイルを import したままコミットする」事故の機械的検知ガード追加 + 他サイクル3件のコミット整理 (2026-10-26)

## 発端

直前の devlog（`2026-10-26_223400_u_build_fail_agent_down.md`）で記録された障害
（`fd95657` が未コミットの `crontab-fix-rules.ts` を import したまま push され、`u` 後に
`ERR_MODULE_NOT_FOUND` で Agent が起動不能になった）は外で復旧済みだったが、**原因そのもの**
（「壊れたコミットを作ってしまうこと」自体）はコード修正されておらず、devlog 内で
「コミット前に別 worktree でクリーンビルド確認する」という運用注意として残っていた。
本サイクルはそこを機械的に検知するガードを追加する。

ユーザーから「全部コミットして」の指示があり、作業ツリーに残っていた他2サイクルの
未コミット WIP（いずれも archive_worklog に経緯・検証結果が記録済みで、過去のユーザー承認は
得ていたが commit/push 未実施のまま残置されていたもの）も合わせて整理した。

## 実測で確認した状態（着手前）

- `fd95657` による被害は他機に拡大していなかった: `Machine` テーブルを read-only クエリし、
  `localCommit = fd95657` は `x220-158-18-103/devrelay` 1台のみ。online 他17台は全て
  `fd95657` より前の `e5983db`。
- 現 HEAD（`7804970`、2ecc2ed/aab5fb4 適用済み）は自己整合（`git archive` で一時展開し
  相対 import 解決先を全チェック）。
- 残っていた未コミット WIP は意図せず3サイクル分が混在:
  1. x220 crontab/service-path サイクル（2026-10-18、`setup.ts` が未追跡の
     `service-path-rules.ts` を import する装填済み状態）
  2. TruckBoard 誤表示根治サイクル（2026-10-22、`document-api.ts` / `cross-query-guard.ts` /
     `agents/macos/skill-manager.ts` + テスト2件、archive_worklog に検証結果まで記録済み）
  3. 本サイクルの土台（ガード追加前の調査）

## 対応: サイクルごとに分離して commit（3コミット）

いずれも commit 前に `pnpm build` + 各パッケージ `pnpm test`（またはフルスイート）を
再実行して green を確認した上で push した。

### commit `ad79f64`: x220 crontab/service-path サイクル
`service-path-rules.ts`（新設・純関数）+ テスト + `setup.ts`（import 追加）+
`doc/server_listen_hang_20261018.md` の追記 + `doc/changelog.md` の該当節。
systemd unit を書く2経路（`install-agent.sh` / `setup.ts`）のテンプレート乖離を根治。
`agents/linux` のみ。テスト1159/1159 green（新規3件）。

### commit `7d6ea46`: TruckBoard 誤表示根治サイクル
`cross-query-guard.ts`（新設・純関数 `resolveCrossSourceLabel()`）+ `document-api.ts`
（ask-member/teamexec-member の推測コード統一）+ `agents/macos/skill-manager.ts`
（#348 フル移植、2026-09-01 輻輳事故の直接原因コード削除）+ テスト2件。
`apps/server` 1371/1371・`agents/macos` 721/722+既知flake1件 green（新規14件）。

### commit `f69f36b`: 本サイクル本体
後述。

## 本サイクル本体: `tracked-imports.test.mjs` の設計

### 判定ルール
「追跡済み or stage 済み」の importer が import する相対パスの実体は、それ自身も
「追跡済み or stage 済み」でなければならない。`git ls-files` ∪
`git diff --cached --name-only --diff-filter=ACMR` の集合に対して判定することで、
**`git add` し忘れた瞬間（commit する前）に落ちる**。HEAD だけを見るチェックでは
「悪いコミットを作った後」にしか分からず、テスト → commit → push → `u` の流れでは手遅れ
になるため、この集合を使うのが要点。

### 実装
`apps/server/tests/tracked-imports.test.mjs`（新規・自己完結1ファイル）。
`collectUntrackedImports(files, readFile, exists, isTracked)` に判定ロジックを切り出し、
7つの単体ケース（fd95657 再現・両方追跡済み・stage済み importee・コメント行除外・
`../`/index.ts 解決・パッケージ名 import 対象外・ディスク上に実体が無い場合は対象外）を
固定した上で、リポジトリ全体（`agents/*/src`・`apps/*/src`・`packages/*/src` の .ts、
342件）に適用する統合テストを追加。

コメント行除外は実例で確認済み: `apps/server/src/services/session-manager.ts:36` の
`// import { sendLineMessage } from '../platforms/line.js';`（`platforms/line.ts` は
存在しない）が誤検知することを事前調査で確認していた。

### 実装中に発見した自分のバグ
`repoRoot = path.resolve(__dirname, '../..')`（2階層）と書いてしまい、
`apps/server/tests` から2階層上ると `apps/` になってしまうため走査対象が0件になっていた
（既存の `*-wiring.test.mjs` 群は `serverRoot` を経由した2段階の書き方のため見た目が近く、
実質3階層であることに気づかず誤って真似た）。`assert.ok(importerFiles.length > 100, ...)`
という最低件数ガードを入れていたおかげでテスト自体が「0件で無言green」にならずに
気付けた（このガード文自体が小さな教訓: 統合テストは「対象0件でも通る」形にしない）。

### ガードの実効性検証
`agents/linux/src/services/__verify_importer__.ts`（`./__verify_ghost__.js` を import）と
`__verify_ghost__.ts` を一時作成し、importer だけ `git add` した状態でガードが fail、
両方 `git add` すると pass に戻ることを確認（fd95657 の再現→解消）。検証後に両ファイルを
削除し `git reset` で stage も戻した（最終コミットには含めていない）。

### 併せて実施: `pnpm test` を node v20 で動くようにする
6パッケージ全ての `package.json` の `"test": "node --test \"tests/**/*.test.mjs\""` を
`"node --test tests/"` に変更。node v20 では glob が展開されず `Could not find` で
全滅していた（`pnpm test` が機能しない状態が常態化し、毎セッションが
`shopt -s globstar` 等で手動回避していた）。安全性を事前に確認: 6パッケージ全てで
`tests/` 配下にネストした `*.test.mjs` が0件、`test`（単数）という名のディレクトリが無い、
`fixtures/` 配下に node のテストファイル判定パターン（`*.test.*js` 等）に当たるファイルが無い。

## 検証結果

`pnpm test` 経由（修正後のスクリプトで実行）:
- `packages/shared`: 104/104 green
- `apps/server`: 1380/1380 green（新規9件 = tracked-imports.test.mjs）
- `agents/linux`: 1159/1159 green
- `agents/macos`: 721/722 green + 既知flake1件（`Unable to deserialize cloned data`、
  node:test ランナー側の IPC flake、再実行で解消。今回変更ファイルと無関係と既に切り分け済み）
- `agents/windows`: 149/149 green
- `apps/web`: 924/924 green

`pnpm --filter @devrelay/{agent,agent-macos,server} build` 全て green。
push 前に `agents/*/src`・`apps/*/src`・`packages/*/src` 全体の自己整合性スキャンを再実行し
問題なしを確認。

## 副次的に発見した事実（今回は対処せず）

`apps/server` を**完全に新規の** `pnpm install --frozen-lockfile`（`/tmp` の一時 worktree）
で構築すると、`site-inventory-service.ts` / `testflight-manager.ts`（今回の変更対象外）で
型エラーが出てビルドが失敗する。本サイクルの commit 前（`7804970`）でも同一の fresh install
で同じエラーが再現することを確認済みのため、**今回の変更が原因ではない**。メイン
worktree（`/opt/devrelay`、時間をかけて蓄積された `node_modules`）では同一ソースで
問題なくビルドできる（`dist/` を削除した完全な再コンパイルでも green）ため、実際の
デプロイ経路（ユーザーが `/opt/devrelay` で手動 `pnpm build` → `pm2 restart`）には影響しない。
原因未特定（@types/node・typescript のバージョンは両環境で一致を確認済み）。別サイクルで
深掘りが必要なら着手する。

## 変更ファイル・影響範囲

| コミット | 変更 | 影響 |
|---|---|---|
| `ad79f64` | `agents/linux` のみ | 各機 `u` 必須 |
| `7d6ea46` | `apps/server` + `agents/macos` | pm2 restart 必須・macOS機 `u` 必須 |
| `f69f36b` | テスト新設 + 6パッケージ `package.json` | ランタイム無変更・`u`/pm2 restart 不要（任意） |

`packages/shared`・Prisma: 3コミット通して無変更。DB マイグレーション不要。
キルスイッチ: なし（テスト・PATH補完・ガード追加のみで、既存動作を変更する設定分岐が無い）。

## 関連
- [2026-10-26_222803_codex_spawn_enoent](2026-10-26_222803_codex_spawn_enoent.md)（発端の fd95657）
- [2026-10-26_223400_u_build_fail_agent_down](2026-10-26_223400_u_build_fail_agent_down.md)（本障害の外部対応記録、2ecc2ed/aab5fb4）
