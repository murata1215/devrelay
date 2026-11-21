# サイクルM1: DB 変更履歴の一元化

## Context（なぜやるか）

DevRelay の DB スキーマ変更は人間が `psql` で手動適用する運用で、`prisma migrate dev` / `migrate deploy` / `db push` は永久禁止（`db push` は schema.prisma に書けない pgvector `embedding` 列を DROP する。`prisma/bootstrap.sql:23-28` に実証記録）。ところが「どの DDL をどこに書くか」のルールが無く、履歴が **5 箇所に分散**している:

| 場所 | 件数・状態 |
|---|---|
| `apps/server/prisma/migrations/` | 20 ディレクトリ・命名3種混在。直近3件（2026-11-02/05/08）は人間の手書き SQL で、DB の `_prisma_migrations` には `applied_steps_count=0` の applied マークだけが入っている |
| `apps/server/prisma/bootstrap.sql` | pgvector 専用（拡張・embedding 列・索引の 6 オブジェクト）。新規 DB 構築専用 |
| `doc/migrations/*.md` | 8 件（DDL ありは 6 件）。**2026-10-11 で運用停止** |
| `doc/devlog/*.md` | 直近の DDL（`CrossAskReset` 等）は実質ここにしか無い |
| `doc/changelog.md` | 「DB マイグレーション適用済み」の定型文のみ |

結果として:
- プルした人が「どこから適用が必要か」を判定する手段が無い（索引ゼロ）。起動時にスキーマと DB の食い違いを検出する処理も無い。
- 別サーバー（会社用 DevRelay、別 DB）の更新手順 `doc/company-repo-sync.md` §5 は `git pull && pnpm build` → 人間が `pm2 restart` だけで、**DB に一切触れていない**。`doc/migrations/377` が警告する「ALTER を飛ばして restart → `column does not exist` で API が 500」が構造的に起きうる。
- `doc/HANDOFF_UBUNTU.md:59,195` は「Prisma エラー → `pnpm db:push`」と案内。稼働中 DB では embedding 列が DROP される（`bootstrap.sql` 冒頭の警告と矛盾）。
- 記録義務がどのルールにも無い（`rules/devrelay.md:55-69` の必須手順も `w` 手順 142-150 も `doc/migrations/` を要求していない）。しかも `rules/devrelay.md:61` / `CLAUDE.md:53` は今も「`prisma migrate dev` を試行」と**明示的に指示**し、`apps/server/package.json:14` に `db:push` がワンキーで残っている。**これが運用停止と事故の構造的原因。**
- 2026-11-11、`CrossAskReset` を postgres ロールで作成して所有者がずれ、アプリロールから 42501 になった（修復済み）。リポジトリ内に `OWNER TO` / `GRANT` の記述は 0 件＝ロール運用が文書化されていない。

**ゴール**: 「1 変更 = 1 SQL ファイル」の単一フォルダ + 索引 1 ファイル + DB 側の適用台帳 + 起動時警告 + 書き忘れ検知テスト を入れ、プル後に「どこから適用が必要か」が git だけでも DB 側からでも分かる状態にする。適用自体は自動化しない（人間が psql で流す）。

---

## 1. フォルダ・ファイル名・索引

### 置き場所: `apps/server/db/changes/`

| 候補 | 判定 |
|---|---|
| `apps/server/prisma/migrations/` | **却下**。Prisma CLI の管理下（`migration_lock.toml` / `_prisma_migrations` と連動）。混ぜると `prisma migrate status` / `resolve` の誘惑が生まれる（既に `applied_steps_count=0` の 3 行で混乱が発生中）。既存 20 件は**凍結**し、索引から参照する |
| `doc/migrations/` | **却下**。文書と実行物が混ざる。既存 8 件は消さず索引の `ref` 列から辿れるようにする |
| **`apps/server/db/changes/`** | **推奨**。`apps/server` スコープ内（変更範囲をサーバー+文書に収める要件を満たす）・`tsconfig.json` の `include: ["src/**/*"]` 外なのでビルドに無影響・Prisma から独立 |

### 構成

```
apps/server/db/changes/
  README.md                      ルール（命名・冪等性・適用ロール・適用コマンド・新規DB の扱い）
  INDEX.tsv                      索引（1 行 1 変更）
  SCHEMA.sha256                  schema.prisma の指紋 1 行（書き忘れ検知用）
  0001_machine_disable_ask.sql
  …
  0031_cross_ask_reset.sql
  0032_db_change_ledger.sql      ← 今サイクルの新規変更（台帳テーブル）
  zz1_verify.sql                 読み取り専用の突合（SELECT のみ）
  zz2_mark_baseline_applied.sql  既に全部適用済みの DB に「適用済み」を一括記録
```

- ファイル名 `NNNN_snake_case_slug.sql`。4 桁ゼロ埋め・時系列昇順・**append-only**（既存ファイルの内容と番号は書き換えない）。
- `zz1`/`zz2` は番号を持たない補助 SQL。`ls` で必ず末尾、かつ **verify → mark の順に並ぶ**ように命名する（`_baseline…` だと `ls` 先頭に来て「最初に流す物」と誤読されるため）。
- `doc/migrations/` の番号（332 等）は `doc/changelog.md` の `#NNN` 連番由来で、その連番自体が #384（2026-09-09）で廃止済み。よって**新採番は独立した通し番号**にする（日付は索引の列で持つ）。

### `INDEX.tsv`（TAB 区切り・`#` 始まりはコメント）

```
# DB 変更の索引。1 行 = 1 変更。append-only。
# プル前後の差分で「増えた行」= 適用が必要な変更。正本は DB 側の台帳 "DbChange"（pnpm db:status）。
# no      変更番号（= ファイル名の NNNN、= "DbChange".no）。欠番は revert/cherry-pick で起こり得る（情報として表示するだけ）
# date    変更が生まれた日付（元サイクルの日付。適用日ではない）
# commit  元コミットの短ハッシュ。新規追加時は未確定なので `-`
# file    SQL ファイル名。`-` = DDL 不要（コメント・@default のみの schema 変更）
# summary 1 行要約
# ref     元の記録（doc/migrations/*.md・prisma/migrations/*・doc/devlog/*.md・bootstrap.sql）。無ければ `-`
#
# baseline: 0001 より前（2026-03-28 以前）は apps/server/prisma/migrations/ の 17 件 + bootstrap.sql を
#           baseline とし個別ファイル化しない（_prisma_migrations に記録済み・prisma/migrations/ は凍結）。
# pgvector: embedding 列と HNSW/ivfflat 索引は prisma/bootstrap.sql の担当。ここには複製しない。
#no	date	commit	file	summary	ref
0027	2026-10-22	d3f3979	0027_session_last_seen_ai_at.sql	Session.lastSeenAiAt + Notification.sessionId 追加（既読のサーバー管理化、backfill あり）	doc/devlog/2026-10-22_conversation_seen_server_managed.md
0032	2026-11-11	-	0032_db_change_ledger.sql	DB 変更台帳 "DbChange" を新設（model DbChange 追加）	-
```

### 元コミットとの紐づけ

- **新規の変更**: SQL ファイル + `schema.prisma` + `INDEX.tsv` + `SCHEMA.sha256` を**同じコミット**に入れる。自分自身のハッシュは書けないので `commit` 列は `-` のままにし、**ファイルを追加したコミットそのものを git から引く**（README と `doc/db-changes.md` にこの 1 行を載せる）:
  ```
  git log --diff-filter=A --format='%h %ad %s' --date=short -1 -- apps/server/db/changes/0032_db_change_ledger.sql
  ```
  `commit` 列に後から手で埋めても良いが**必須にしない**（後追い更新を忘れて索引が嘘になる状態を作らないため）。
- **遡及分**: ハッシュは履歴から確定しているので短ハッシュを書く。

---

## 2. 「どこから適用が必要か」の 2 系統

### (a) git だけで分かる手順

```
cd /opt/devrelay
git rev-parse HEAD > /tmp/devrelay-before          # ← pull の前に取る
git pull
git diff --name-only --diff-filter=AM "$(cat /tmp/devrelay-before)" HEAD -- apps/server/db/changes/
# 何も出なければ DB 変更なし。出たファイルを番号順に psql で流す。
```
- `--diff-filter=AM`（A だけでなく M も拾う）。append-only ルール上 **M が出ること自体が異常**なので、出たら `doc/db-changes.md` の注意を読む。
- 取り忘れた場合のフォールバック（reflog 依存、実機で動作確認済み）: `git diff --name-only --diff-filter=AM 'HEAD@{1}' HEAD -- apps/server/db/changes/`
- 人間が読む版: `git diff 'HEAD@{1}' HEAD -- apps/server/db/changes/INDEX.tsv`
- **正本は (b)**。git 手順は「pull 直後に DB 作業があるかを 1 コマンドで知る」ための補助と `doc/db-changes.md` に明記する。

### (b) DB 側の台帳 + `pnpm db:status`

#### 台帳テーブル `"DbChange"`

`schema.prisma` に model として書く（書かないと drift が 1 件増えるため）。**同一性はファイル名（`name`）で持ち、番号は表示用の非ユニーク列**にする:

```prisma
/// DB 変更の適用台帳（サイクルM1）。apps/server/db/changes/NNNN_*.sql の各ファイルが
/// 末尾で自分のファイル名を記録する。行の存在 ⇔ そのファイルが適用済み。
/// 適用は人間が psql で行う（migrate dev / migrate deploy / db push は使わない）。
/// name を主キーにしているのは、会社リポとの同期（company-repo-sync.md §3/§4 の merge・
/// cherry-pick）で両側が同じ番号を採ったとき、整数 PK では一方が
/// ON CONFLICT DO NOTHING で黙って「適用済み」になってしまうため。
model DbChange {
  name      String   @id     // ファイル名（例: 0032_db_change_ledger.sql）
  no        Int                // 表示・並び順用の番号（unique にしない）
  appliedAt DateTime @default(now())
  appliedBy String?            // 適用時の current_user（所有者ずれ調査用）
}
```
型は Prisma 生成形に厳密に合わせる（`TEXT` / `INTEGER` / `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`）。`appliedBy` に `DEFAULT current_user` は**付けない**（Prisma で表現できず drift になる。INSERT の VALUES で渡す）。

#### 各 SQL ファイルの共通フォーマット

```sql
-- ============================================================
-- 0027 / 2026-10-22 / commit d3f3979
-- サイクル: 会話既読状態のサーバー管理化 + Notification.sessionId 追加
-- 内容: Session.lastSeenAiAt（TIMESTAMP(3) NULL）・Notification.sessionId（TEXT NULL）を追加
-- 注意: backfill あり。既に適用済みの DB では zz2_mark_baseline_applied.sql を先に流すこと
--       （未読スレッド 2,145 件を誤って既読にする。カットオフと台帳で三重ガード済みだが順序を守る）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0027_....sql
-- ============================================================
SET search_path TO public;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- 台帳（本文の冪等ガードが参照するのでヘッダで作る。どのファイルからでも単独適用できるようにする）
CREATE TABLE IF NOT EXISTS "DbChange" (
  "name"      TEXT NOT NULL,
  "no"        INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy" TEXT,
  CONSTRAINT "DbChange_pkey" PRIMARY KEY ("name")
);

-- 誤爆ガード（3 段。すべて実機で成立を確認済み）
DO $$
DECLARE app_role text;
BEGIN
  -- ① DevRelay の DB か（DATABASE_URL が空で既定 DB に繋がった等の誤爆防止）
  IF to_regclass('public."Machine"') IS NULL THEN
    RAISE EXCEPTION 'DevRelay の DB ではありません（public."Machine" が無い）。接続先 % を確認してください。新規 DB 構築はこのフォルダの担当外です（README 参照）', current_database();
  END IF;
  -- ② superuser で流していないか
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION 'superuser (%) では適用しないでください。アプリと同じロールで流すか SET ROLE してください', current_user;
  END IF;
  -- ③ 既存表の所有者と一致しているか
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Machine';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Machine" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "lastSeenAiAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

-- backfill（三重ガード: 台帳に無い / まだ NULL / 導入日より前に始まったスレッドのみ）
UPDATE "Session" s
   SET "lastSeenAiAt" = (SELECT MAX(m."createdAt") FROM "Message" m
                          WHERE m."sessionId" = s."id" AND m."role" = 'ai')
 WHERE s."lastSeenAiAt" IS NULL
   AND s."startedAt" < TIMESTAMP '2026-10-22 00:00:00'
   AND NOT EXISTS (SELECT 1 FROM "DbChange" WHERE "name" = '0027_session_last_seen_ai_at.sql');

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0027_session_last_seen_ai_at.sql', 27, current_user)
ON CONFLICT ("name") DO NOTHING;
```

- DDL は全て `IF NOT EXISTS`。型は Prisma 生成形（`String?`→`TEXT`、`Int?`→`INTEGER`、`DateTime?`→`TIMESTAMP(3)`、`Boolean`→`BOOLEAN NOT NULL DEFAULT false`）。
- `psql -1`（単一トランザクション）+ `-v ON_ERROR_STOP=1`。`CREATE INDEX CONCURRENTLY` 等が必要な将来の変更は先頭コメントに `-- no-single-transaction` マーカーを置き `-1` を外す規約を README に明記（テストもこのマーカーを許可する）。

#### `pnpm --filter @devrelay/server db:status`（読み取り専用）

`apps/server/src/scripts/db-status.ts` → `dist/scripts/db-status.js`（`knowledge:backfill` と同形。`src/scripts/` 配下なので `tsc` が自動出力）。**先頭に `import 'dotenv/config';`**（`knowledge-backfill.ts` は dotenv 未読込で env 依存。`--filter` 実行時は cwd=`apps/server` なので実ファイルの `apps/server/.env` を拾う）。SQL ファイルは `tsc` の出力に入らないので**パスは `__dirname` からの相対（`dist/scripts/` → `../../db/changes`）で解決し、cwd に依存させない**。

```
$ pnpm --filter @devrelay/server db:status
DB 変更履歴: apps/server/db/changes/（索引 INDEX.tsv）
接続: devrelay_user@devrelay
台帳 "DbChange": あり（記録 31 件）
索引: 32 行（SQL ファイル 31 / DDL 不要 1）

未適用 1 件:
  no    date        file                       summary
  0032  2026-11-11  0032_db_change_ledger.sql  DB 変更台帳 "DbChange" を新設

番号の小さい順に 1 つずつ流してください:
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0032_db_change_ledger.sql
```
```
台帳 "DbChange": あり（記録 32 件）
未適用: なし ✅
```
```
台帳 "DbChange": 存在しません（全 31 件を未適用として扱います）
→ DB が既に最新なら: zz1_verify.sql で突合 → MISSING が 0 行なら zz2_mark_baseline_applied.sql
→ DB が古いなら: 0001 から番号順に psql で流す
→ 新規 DB の構築はこのフォルダの担当外（README / doc/db-changes.md 参照）
```
さらに以下も 1 行で報告する: **DB 先行**（台帳にあるのに索引に無い＝コードを巻き戻した状態）、**欠番**、**番号の重複**（会社リポとの merge で起こる）。終了コードは常に 0（`--strict` を付けたときのみ未適用ありで 1）。適用は一切しない。

#### 起動時警告（fail-open）

`apps/server/src/index.ts` の **`app.listen()` より前**、既存 DB メンテナンスブロック（161 行）直後に 1 行:
```ts
await runStartupInitWithTimeout('DB 変更履歴の検査', () => warnOnPendingDbChanges());
```
`runStartupInitWithTimeout()`（47-62 行）が 20 秒タイムアウト + 失敗時 `console.error('⚠️ 起動前処理「…」に失敗しました（続行します）')` を既に備えているので **fail-open が無料で付く**。

```
⚠️  ──────────────────────────────────────────────────────────
⚠️  未適用の DB 変更が 2 件あります（起動は続行します）
⚠️    0031  2026-11-11  0031_cross_ask_reset.sql   CrossAskReset テーブル新設
⚠️    0032  2026-11-11  0032_db_change_ledger.sql  DB 変更台帳 "DbChange" を新設
⚠️  Prisma Client が存在しない列を参照すると API が 500 になります。
⚠️  確認: pnpm --filter @devrelay/server db:status / 手順: doc/db-changes.md
⚠️  ──────────────────────────────────────────────────────────
```
**3 状態を明示的に出し分ける**（Prisma は接続不能を `P1001`/`P1017`、権限不足とテーブル不在を**両方 `P2010`** に包み、PG の SQLSTATE は `error.meta.code` 側に出るため、ここを分けないと会社サーバーで最も知りたい「台帳が無い＝一度も導入していない」が「DB 落ち」と同じ 1 行になる）:

| 状態 | 判定 | 文言 |
|---|---|---|
| 台帳なし | `42P01` | `⚠️ DB 変更台帳 "DbChange" がありません（起動は続行します）。doc/db-changes.md の手順で導入してください` |
| 権限不足 | `42501` | `⚠️ "DbChange" を読めません（権限不足）。所有者ずれの可能性があります（current_user を確認）` |
| 接続不能 | `P1001`/`P1017` | `⚠️ DB に接続できないため DB 変更履歴を検査できませんでした（起動は続行します）` |

- キルスイッチ `DEVRELAY_DB_CHANGE_WARN`（既定 `1`、`0` で検査自体をしない）。判定は既存の `is*Enabled(raw)` 形（`cross-team-guard.ts` 等）に合わせる。
- `/health`（`index.ts:196`、既に `getBotsHealth()` を返している）に `dbChanges: { state, pending }` を 1 フィールド追加する。pm2 ログは会社サーバーでは誰も見ないため、HTTP で取れる出口を用意する。

新設サービス `apps/server/src/services/db-change-index.ts`:
- 純関数: `parseChangeIndex(text)` / `diffDbChanges(rows, appliedNames)`（pending / dbAhead / gaps / duplicateNumbers を返す）/ `formatPendingWarning(result)` / `classifyDbChangeError(err)`
- I/O: `loadChangeIndex()` / `fetchAppliedDbChanges()` / `warnOnPendingDbChanges()`
（既存慣例どおり純関数を分離し `*-rules` 流儀のテストから直接検証する）

---

## 3. 書き忘れ防止（`apps/server/tests/db-changes.test.mjs`）

既存の `knowledge-wiring.test.mjs`（`prisma/bootstrap.sql` を正規表現で検査する先例）と `tracked-imports.test.mjs`（`git ls-files` でリポジトリ全体を検査する先例）に倣う。

1. **純関数**: `parseChangeIndex` / `diffDbChanges` / `formatPendingWarning` / `classifyDbChangeError` の単体ケース。
2. **指紋照合（本体）**: `SCHEMA.sha256`（1 行・`<sha16>␣<変更ファイル名>` 形式）について
   - `sha256(prisma/schema.prisma)` の先頭 16 桁が第 1 フィールドと一致
   - 第 2 フィールドが `INDEX.tsv` の**最大番号の行**のファイル名と一致
   → `schema.prisma` を変えて変更ファイル・索引行を足し忘れると落ち、エラーメッセージが手順そのものを出す。DDL 不要な変更（コメント・`@default` のみ）は `file` 列が `-` の行で登録できる（詰みを作らない）。
   指紋を TSV の列ではなく**単一行ファイル**に置くのは、会社リポとの `--no-ff` merge で TSV 最終行が毎回コンフリクトし、かつ merge 後の schema.prisma がどちらの行の指紋とも一致しなくなるため（復旧は `sha256sum apps/server/prisma/schema.prisma | cut -c1-16` の 1 コマンドで足りる旨を README に書く）。
   **この指紋は「schema.prisma を触ったのに記録しない」しか捕まえない**（embedding 列・DESC 索引・部分索引・FK 等、schema.prisma を変えずに打てる DDL は対象外）。その旨を `doc/db-changes.md` に明記し、双方向検査（`pnpm db:drift`）は残課題として記録する。
3. **索引とファイルの突合**: `NNNN_*.sql` の集合 = 索引の `file` 列の集合。番号はユニークかつ昇順（**欠番は許容**＝revert/cherry-pick で起こり得る）。`file` の `NNNN` と `no` が一致。
4. **各 SQL の自己整合**: 末尾の `INSERT INTO "DbChange"` の `name` が自分のファイル名、`no` が自分の番号。
5. **冪等性 lint**: `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` に `IF NOT EXISTS`。`UPDATE` / `DELETE` を含むファイルは `"DbChange"` の `NOT EXISTS` ガードを持つ。
6. **ガード必須**: 全ファイルがヘッダの 3 段ガード（`Machine` 存在 / `usesuper` / 所有者一致）と `CREATE TABLE IF NOT EXISTS "DbChange"` を持つ。`OWNER TO` / `SET ROLE` / `CREATE EXTENSION` / `sudo` を含まない（superuser 前提の混入防止。pgvector は `bootstrap.sql` の担当）。
7. **ヘッダ必須項目**: 日付・元コミット（または `-`）・サイクル名・内容・注意点・適用ロール・適用コマンドの各行。
8. **追跡漏れ検知**: `git ls-files` ∪ `git diff --cached --name-only` に全 SQL ファイル・`INDEX.tsv`・`SCHEMA.sha256` が含まれる（`tracked-imports.test.mjs` の `getTrackedOrStagedFiles()` と同手口）。
9. **禁止コマンドの封じ込め（新規・重要）**: `apps/server/package.json` の `scripts` に `prisma db push` / `prisma migrate dev` / `prisma migrate deploy` が**存在しないこと**。`prisma/migrations/` のディレクトリ数が 20 のままであること（凍結の固定）。`CLAUDE.md` / `rules/devrelay.md` の DB 手順に `migrate dev` が**出てこないこと**。

---

## 4. 遡及の対象

`schema.prisma` を変えた直近 30 コミットの差分を全件精査した結果、**DDL を要するのは 29 コミット / DDL 不要が 1 コミット**。`9f1990a`（12 日分のバッチコミット）だけは中に別サイクルの変更が 2 件（既存の `prisma/migrations/` も日付別に 2 ディレクトリ存在）混ざるので 2 ファイルに割る。→ **索引 32 行・SQL ファイル 31 本**（最後の 0032 が今サイクルの台帳導入）。

> **依頼文の「23 件」との差（報告事項）**: 依頼の内訳（SQL が文書にある 8・文章だけ 3・どこにも無い 12）＝ 23 に対し、私の棚卸しでは **31 件**になりました。差の 8 件は (1) `@default` 変更のみ 2 件（`0b32c83` / `878429a` — Prisma の `@default` は DB の `DEFAULT` 句なので `ALTER COLUMN SET DEFAULT` が必要）、(2) 2026-04〜05 の古い 4 件（`5da2879` / `635a134` / `53fd99c` / `d80a18a`。`prisma/migrations/` に対応ディレクトリが無く DB には適用済み）、(3) `9f1990a` の分割で +1、(4) 台帳導入そのもので +1。番号を取って索引に載せる副作用は無いので**全部入れる**方針にしました。

| no | 日付 | commit | DDL の要約 | ref |
|---|---|---|---|---|
| 0001 | 2026-03-29 | 5da2879 | `Machine."disableAsk" BOOLEAN NOT NULL DEFAULT false` | - |
| 0002 | 2026-03-29 | 635a134 | `ToolApproval."isQuestion" BOOLEAN NOT NULL DEFAULT false` | - |
| 0003 | 2026-04-01 | 53fd99c | `Project."description" TEXT` | - |
| 0004 | 2026-04-01 | 1bdee10 | `Project."displayName" TEXT` | `prisma/migrations/20260401_add_project_display_name` |
| 0005 | 2026-04-07 | d80a18a | `CREATE TABLE "Notification"`（9 列）+ FK×2 + 索引×2 | - |
| 0006 | 2026-05-23 | a975560 | `Project."terminalMode" BOOLEAN NOT NULL DEFAULT false` | `prisma/migrations/20260523_add_project_terminal_mode` |
| 0007 | 2026-06-21 | 0b32c83 | `Project."terminalMode" SET DEFAULT true` | - |
| 0008 | 2026-07-18 | 878429a | `Project."terminalMode" SET DEFAULT false`（0007 を戻す） | - |
| 0009 | 2026-07-20 | 1152120 | `CREATE TABLE "Organization"` / `"OrganizationMember"` + FK + 索引 | - |
| 0010 | 2026-07-25 | b17975b | `CREATE TABLE "ManagerAssignment"` / `"PersonalAccessToken"` / `"SupervisionAuditLog"` + `Organization."allowedIpRanges"` + `Session."summary"/"summarizedAt"` + `Message_sessionId_createdAt_idx`（1 コミットに統制 v2/v3 の 4 サイクル分が同居。ヘッダで内訳を列挙し、表→索引→FK の順に並べる） | - |
| 0011 | 2026-08-14 | 13c7446 | `Machine` に `autoUpdate`/`lastAutoUpdateAt`/`lastAutoUpdateCommit`/`lastAutoUpdateStatus`/`autoUpdateAttempts` | - |
| 0012 | 2026-08-14 | 3d6a6ee | `Machine` に `localCommit`/`localCommitDate`/`remoteCommit`/`remoteCommitDate`/`versionCheckedAt` | - |
| 0013 | 2026-08-15 | 009cf1c | `Machine."runningCodeMtime"/"runningCodeStale"` | - |
| 0014 | 2026-08-23 | 7dfe61e | `Project."deletedAt" TIMESTAMP(3)` | - |
| 0015 | 2026-08-28 | 03c2c4c | `Machine."claudeAuthOk"/"claudeAuthCheckedAt"/"claudeAuthAccount"` | - |
| 0016 | 2026-08-29 | 641ec0a | `Session."councilMode" BOOLEAN NOT NULL DEFAULT false` + `"approvalNote" TEXT` | - |
| 0017 | 2026-08-29 | add09f4 | `ToolApproval."reason" TEXT` | `doc/migrations/332_tool_approval_reason.md` |
| 0018 | 2026-08-30 | a4afb4a | `Message."humanTextMeta" TEXT` | `doc/migrations/334_message_human_text_meta.md` |
| 0019 | 2026-09-08 | 9c49644 | `Organization."aiModelDefaults" TEXT` + `OrganizationMember."canOverrideAiSettings" BOOLEAN NOT NULL DEFAULT false` + `Session."planTurnId"/"planAiSessionId"/"planAiTool"/"approvedAt"` | `doc/migrations/372_org_ai_defaults.md`・`376_session_scope.md` |
| 0020 | 2026-09-08 | 8c1dc69 | `BuildLog."stopReason" TEXT` | `doc/migrations/377_sdk_max_turns_stop_reason.md` |
| 0021 | 2026-09-09 | 93b0e91 | `Session."title"/"lastActiveAt"/"agentScopeId"` + `Session_projectId_status_lastActiveAt_idx` | `doc/devlog/2026-09-09_202517.md` |
| 0022 | 2026-09-13 | 4552776 | `Machine."capabilityConfig" JSONB` / `"capabilitySyncStatus" JSONB` | - |
| 0023 | 2026-09-26 | a3c91aa | `Session."kind" TEXT` / `"cancelledAt" TIMESTAMP(3)` | - |
| 0024 | 2026-10-10 | 6ae9c8e | `CREATE TABLE "KnowledgeChunk"`（14 列）+ unique 1 + 索引 3。**`embedding vector(1536)` と HNSW 索引は `bootstrap.sql` 5/6 の担当**（ヘッダに明記し複製しない） | `prisma/bootstrap.sql` |
| 0025 | 2026-10-11 | 815c504 | `Project."defaultLevel" INTEGER` / `"defaultCompartment" TEXT` + `Session."level" INTEGER` / `"compartment" TEXT` + `CREATE TABLE "UserClearance"`（`compartments TEXT[]`、NOT NULL なし） | `doc/migrations/knowledge2_classification.md` |
| 0026 | 2026-10-18 | a3f4254 | **DDL 不要**（`TestflightService.port` のコメントのみ） | - |
| 0027 | 2026-10-22 | d3f3979 | `Session."lastSeenAiAt"` + `Notification."sessionId"` + **backfill UPDATE** | `doc/devlog/2026-10-22_conversation_seen_server_managed.md` |
| 0028 | 2026-11-02 | 9f1990a | `Notification."projectId" DROP NOT NULL` | `prisma/migrations/20261102000000_notification_project_optional` |
| 0029 | 2026-11-05 | 9f1990a | `CREATE TABLE "CrossTeamInvite"/"CrossTeamGrant"/"CrossTeamAuditLog"` + `Session."requestedByUserId"` + FK×2 + 索引 9 | `prisma/migrations/20261105000000_add_cross_team_grant` |
| 0030 | 2026-11-09 | 24df6bb | `Team."visibility" TEXT NOT NULL DEFAULT 'private'` + `CREATE TABLE "TeamSubscription"` + FK + 索引 3 | `prisma/migrations/20261108000000_add_team_subscription` |
| 0031 | 2026-11-11 | 582c42f | `CREATE TABLE "CrossAskReset"` + unique 索引 | `doc/devlog/2026-11-11_201901.md` |
| 0032 | 2026-11-11 | （今サイクル） | `CREATE TABLE "DbChange"` + `schema.prisma` に `model DbChange` | - |

**粒度のルール（README に明記）**: 原則「1 コミット = 1 ファイル」。1 コミットに複数サイクルの DDL が混ざる場合は 1 ファイルにまとめてヘッダで内訳を列挙する（`b17975b`）。既存の `prisma/migrations/` が日付別に分かれている場合はそれに合わせて分割する（`9f1990a`）。

**遡及ファイルの位置づけ（重要・README と `doc/db-changes.md` に明記）**: これは**履歴の記録**であり、**新規 DB の構築経路ではない**。新規 DB は従来どおり `pnpm db:bootstrap`（`prisma db push` + `bootstrap.sql`。空 DB に対しては安全）で作り、その後 `zz1_verify.sql` → `zz2_mark_baseline_applied.sql` で台帳を埋める。これにより「本番では絶対に走らない 31 本が、唯一の新規構築経路として未検証のまま残る」状態を回避する（ヘッダのガード① `Machine` 存在チェックが、空 DB への誤用を構造的に止める）。

### 起こした DDL が本番 DB と一致することの検証（SELECT のみ）

`zz1_verify.sql`（読み取り専用）に 3 本のクエリを入れる。**本プラン作成時点で実機実行し、下記は全て期待どおりであることを確認済み**:

1. **列の突合**: 期待する `(table, column)` を `VALUES` で持ち `information_schema.columns` と `LEFT JOIN`、`data_type`/`is_nullable`/`column_default` を並べ、欠落を `MISSING` として出す。
   - 実機確認済み（43 列）: `Session.lastSeenAiAt = timestamp without time zone / YES`、`Machine.capabilityConfig = jsonb / YES`、`Project.terminalMode = boolean / NO / false`、`Team.visibility = text / NO / 'private'::text`、`OrganizationMember.canOverrideAiSettings = boolean / NO / false`、`ToolApproval.isQuestion = boolean / NO / false`、`Machine.disableAsk = boolean / NO / false` 他すべて存在。
2. **テーブルと所有者**: `pg_tables` を `tableowner` で集計し、**所有者が 1 種類でなければ `MISSING`（所有者ずれ）として出す**。
   - 実機確認済み: 33 テーブルすべて `devrelay_user`（`CrossAskReset` 含む。2026-11-11 の所有者ずれは修復済み）。
3. **索引の突合**: `pg_indexes` で期待索引名の存在を確認。
   - 実機確認済み: `Session_projectId_status_lastActiveAt_idx`・`Message_sessionId_createdAt_idx`・`KnowledgeChunk_*` 4 本・`UserClearance_userId_key`・`CrossAskReset_requesterUserId_projectId_key`・`ManagerAssignment_*` 4 本・`SupervisionAuditLog_*` 他すべて存在。

### 既知 drift（M1 では直さない。`doc/db-changes.md` の「既知 drift」節に記録のみ）

`prisma migrate diff --from-url <本番> --to-schema-datamodel prisma/schema.prisma --script` の実行結果（読み取り専用、実機取得済み）:

| drift | 実 DB | schema.prisma | 判定 |
|---|---|---|---|
| `MessageFile`/`AgentDocument`/`KnowledgeChunk`.`embedding vector(1536)` | あり | 書けない | **意図的**。Prisma は DROP したがる（= `db push` 禁止の根拠） |
| `idx_messagefile_embedding` / `idx_knowledgechunk_embedding` | あり | 書けない | **意図的**（`bootstrap.sql`） |
| `Notification_userId_createdAt_idx` | `("userId","createdAt" DESC)` | DESC なし | 手調整。実害なし |
| `Notification_userId_isRead_idx` | 部分索引 `WHERE isRead=false` | 部分条件なし | 手調整。実害なし |
| `Notification_projectId_fkey` | `NO ACTION` | `SetNull`（optional 列の既定） | **軽微な実害あり**（通知が残る Project の削除が失敗しうる）。M1 対象外・別サイクル |
| `PersonalAccessToken_userId_fkey` | `CASCADE` | `CASCADE` | `ON UPDATE` 差。実害なし |

---

## 5. 既に全部適用済みの DB（本番）への「適用済み」の入れ方

**結論: `zz2_mark_baseline_applied.sql` で一括記録する（全ファイルを流す方式は採らない）。**

31 本すべて冪等だが、**0027 の backfill は本番の `Session` 12,680 行のうち `lastSeenAiAt` が NULL な 2,145 行（＝本当に未読のスレッド）を書き換えうる**ため、「流せば記録される」に頼らず記録を先に入れる。

本番（devrelay.io）の手順（人間が実行）:
```
cd /opt/devrelay
export DATABASE_URL="$(sed -n 's/^DATABASE_URL="\{0,1\}\(.*[^"]\)"\{0,1\}$/\1/p' .env | tail -1)"
test -n "$DATABASE_URL" && echo OK     # ← 空のまま psql に渡すと既定 DB に繋がるので必ず確認
# 1. 突合（読み取り専用）。MISSING が 0 行であることを確認
psql "$DATABASE_URL" -f apps/server/db/changes/zz1_verify.sql
# 2. 0032（台帳 + model DbChange）はまだ未適用なので、これだけ流す
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0032_db_change_ledger.sql
# 3. 0001〜0031 を「適用済み」として一括記録
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/zz2_mark_baseline_applied.sql
# 4. 確認
pnpm --filter @devrelay/server db:status      # → 未適用: なし
# 5. npx prisma generate → pnpm build → pm2 restart devrelay-server（--update-env は使わない）
```

`zz2_mark_baseline_applied.sql` の中身: 共通ヘッダ（3 段ガード + 台帳作成）+ **突合ゲート** + `INSERT ... VALUES (…31 行…) ON CONFLICT ("name") DO NOTHING`（`appliedBy = 'baseline(2026-11-11)'`）。

**突合ゲート（構造的な誤爆防止）**: `zz1_verify.sql` と同じ期待列リストを `DO` ブロックで評価し、**欠落が 1 件でもあれば `RAISE EXCEPTION` して中断**する。
```sql
-- ★★★ 警告 ★★★
-- これは「0001〜0031 が既に適用済みであることを zz1_verify.sql で確認できた DB」専用です。
-- 未適用の DB に流すと、未適用の変更が永久に「適用済み」として隠れます（最も静かで最も高い失敗）。
-- 下の DO ブロックが欠落を検出したら中断しますが、必ず先に zz1_verify.sql を見てください。
```
これで「状態が不明な会社サーバーで `ls` の並び順に従って先に流してしまった」事故が構造的に起きない。

---

## 6. 変更するファイル

### 新規（サーバー）
- `apps/server/db/changes/README.md` / `INDEX.tsv` / `SCHEMA.sha256`
- `apps/server/db/changes/0001_*.sql` 〜 `0031_*.sql`（30 本。0026 は DDL 不要でファイルなし）
- `apps/server/db/changes/0032_db_change_ledger.sql`
- `apps/server/db/changes/zz1_verify.sql` / `zz2_mark_baseline_applied.sql`
- `apps/server/src/services/db-change-index.ts`（純関数 + I/O）
- `apps/server/src/scripts/db-status.ts`
- `apps/server/tests/db-changes.test.mjs`

### 変更（サーバー）
- `apps/server/prisma/schema.prisma` — `model DbChange` を末尾に追加
- `apps/server/src/index.ts` — 161 行直後に 1 行 + `/health` に `dbChanges` フィールド
- `apps/server/package.json` — `"db:status"` を追加。**`"db:push"` を削除**、`"db:bootstrap"` を `"db:bootstrap:new-db-only"` に改名（永久禁止のコマンドがワンキーで打てる状態を無くす。`testflight-manager.ts` と生成テンプレート内の `db push` は別 DB 向けなので対象外）
- `apps/server/prisma/bootstrap.sql` — 冒頭コメントに「pgvector 専用。それ以外の DB 変更は `db/changes/`」の 2 行 + `db:bootstrap` 改名の反映
- `apps/server/prisma/migrations/` — **凍結**。`migration_lock.toml` の隣に 1 行の `README.md` を置き「ここは Prisma が生成した 20 件の凍結済み履歴。以後の DB 変更は `../../db/changes/`」と書く（新規ファイルは作らない）

### 変更（文書）
- **新規 `doc/db-changes.md`** — 唯一の運用手順書（フォルダ・命名・索引・適用コマンド・ロール規約・git 手順・`db:status`・起動時警告の 3 状態・既知 drift・baseline の扱い・新規 DB の扱い・残課題）
- `doc/company-repo-sync.md` §5 — `git pull` の後に DB 工程を挿入（§2(a) のコマンド → 番号順に psql → `prisma generate` → `pnpm build` → 人間が `pm2 restart`。初回のみ `zz1_verify` →（全部適用済みなら）`zz2_mark_baseline_applied`。**`postgres` では流さない**を明記）
- `doc/HANDOFF_UBUNTU.md` — 55-60 行「4. データベース初期化」を `pnpm db:bootstrap:new-db-only`（**新規 DB 専用**）+ `db/changes/` の扱いに差し替え。192-196 行「Prisma エラー → `pnpm db:push`」を**削除**し「`pnpm db:status` で未適用を確認 → psql で適用」に差し替え（稼働中 DB への `db push` は embedding 列 DROP で禁止である旨を明記）
- `CLAUDE.md` — 「DB スキーマ変更時の必須手順」を改訂（`migrate dev` の試行を**やめる**。`db/changes/NNNN_*.sql` + `INDEX.tsv` + `SCHEMA.sha256` を**同じコミットに含める**を手順に追加、適用ロール規約を追加）。環境変数表に `DEVRELAY_DB_CHANGE_WARN`、DB テーブル表に `DbChange`、「詳細ドキュメント」に `doc/db-changes.md` を追加
- `rules/devrelay.md:55-69` — 同じ改訂（詳細版）。`w` 手順（142-150）に「DB 変更があれば `db/changes/` と索引を同じコミットに含める」を 1 行追加
- `doc/changelog.md` — サイクルM1 の節を追記
- `doc/devlog/YYYY-MM-DD_HHMMSS.md` — 新規 1 ファイル（`TZ=Asia/Tokyo date '+%Y-%m-%d_%H%M%S'`）+ `INDEX.md` 末尾に 1 行

### 無変更（各機の `u` を不要にする）
`apps/web` / `agents/*` / `packages/shared` は一切触らない。`git diff --stat` で確認して完了報告に載せる。

---

## 7. 検証（exec 時）

1. `pnpm build` 6 workspace green、`grep -c 'require(' apps/web/dist/assets/index-*.js` = 0
2. `cd apps/server && node --test --test-concurrency=1 tests/` — 既存 1648 件 + 新規（`db-changes.test.mjs` 30〜40 件想定）が green
3. `git diff --stat` で `apps/web`・`agents/*`・`packages/shared` が 0 変更
4. **指紋テストが実際に機能することの確認**: `schema.prisma` にコメント 1 行を足して `node --test tests/db-changes.test.mjs` が落ちることを確認し、その行を戻す（件数を報告）
5. `psql "$DATABASE_URL" -f apps/server/db/changes/zz1_verify.sql` を実行し MISSING が 0 行であることを確認（**読み取り専用。DDL は一切適用しない**）
6. `pnpm --filter @devrelay/server db:status` を実行し「台帳なし → 全 31 件を未適用として表示」の出力を確認（適用はしない）
7. 起動時警告は `pm2 restart` をしないため実機確認できない。`formatPendingWarning()` / `classifyDbChangeError()` の出力文言をテストで固定し、`node -e` で `warnOnPendingDbChanges()` を直接 1 回呼んで実出力を完了報告に貼る

## 8. 作業量と分割

30 分では収まらない見込み（SQL 31 本 + ツール + テスト + 文書 6 本）。**依頼どおりの順序で 3 コミットに分け、各段階で green を確認する**:

| 段階 | 内容 | 見積 | commit |
|---|---|---|---|
| **M1a** | `model DbChange` + `0032_*.sql` + `INDEX.tsv`（0032 の 1 行）+ `SCHEMA.sha256` + `db-change-index.ts` + `db-status.ts` + 起動時警告 + `/health` + `package.json`（`db:push` 削除・改名）+ テスト一式 | 40〜50 分 | 1 |
| **M1b** | 遡及 SQL 30 本 + `INDEX.tsv` に 31 行追記 + `zz1_verify.sql` + `zz2_mark_baseline_applied.sql` + `README.md` 2 本 | 40〜55 分 | 2 |
| **M1c** | `doc/db-changes.md` 新規 + `company-repo-sync.md` §5 + `HANDOFF_UBUNTU.md` + `CLAUDE.md` + `rules/devrelay.md` + `changelog.md` + devlog | 20〜30 分 | 3 |

指紋を `SCHEMA.sha256` の単一行ファイルに置いたので、**M1a 単独でも、M1b を足した後でも整合する**（最大番号は常に 0032）。索引の番号は「ユニーク・昇順・欠番許容」とするため、M1a 時点で 0032 だけが載っていてもテストは green。

1 回の exec で 3 段階を通す想定だが、時間が厳しくなった場合は **M1a まで（commit 1）で止めて報告**し、M1b/M1c を次の submission に回す。

## 9. 残課題（M1 では実装しない。`doc/db-changes.md` に記録）

- **`pnpm db:drift`**: `prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel`（shadow DB 不要・実機で動作確認済み）の出力を、コミット済みの「既知 drift 許容リスト」と突合する双方向検査。§3-2 の指紋が捕まえられない「schema.prisma を変えずに打った DDL」を捕まえる本命。
- 台帳に `checksum` 列（適用後のファイル編集検知）。ファイルが自分のハッシュを持てないため設計を要検討。
- `Notification_projectId_fkey` の `NO ACTION` → `SetNull`（上表の唯一の実害ある drift）。

## 10. exec 時の制約（再確認）

- DB への適用は一切しない。`prisma migrate dev` / `migrate deploy` / `db push` は使わない。`zz1_verify.sql` と `db:status` の **SELECT のみ**実行する。
- `pm2 restart` は実行しない。シェルコマンドは 1 つずつ（`&&` / `;` で連結しない）。
- `npx prisma generate` は `model DbChange` 追加時にビルドのため必要（DB には触らない操作）。
- devlog は新規 1 ファイルのみ。既存 devlog への追記・一括読み込みはしない。
- 完了報告に載せるもの: commit hash / push 結果 / 各テスト件数 / 本番で流す SQL と実行順（§5）/ 会社サーバーでの手順（§6）/ `db:status` の使い方。
