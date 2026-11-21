# apps/server/db/changes/ — DB 変更履歴（サイクルM1）

DevRelay の DB スキーマ変更は人間が `psql` で手動適用する運用です。
**`prisma migrate dev` / `migrate deploy` / `db push` は使いません**
（`db push` は schema.prisma に書けない pgvector `embedding` 列を DROP します。
`apps/server/prisma/bootstrap.sql` 冒頭の警告を参照）。

運用の全体像は `doc/db-changes.md` を参照してください。本ファイルはこのフォルダ固有のルールのみ。

## フォルダの中身

| ファイル | 役割 |
|---|---|
| `INDEX.tsv` | 索引。1 行 = 1 変更。プル前後の差分で「増えた行」= 適用が必要な変更 |
| `SCHEMA.sha256` | `schema.prisma` の指紋。書き忘れ検知テスト（`tests/db-changes.test.mjs`）が使う |
| `NNNN_*.sql` | 1 変更 = 1 ファイル。4 桁ゼロ埋め・時系列昇順・**append-only**（既存ファイルの内容・番号は書き換えない） |
| `zz1_verify.sql` | 読み取り専用の突合（期待する表・列・索引の存在を SELECT で確認。DDL は含まない） |
| `zz2_mark_baseline_applied.sql` | 既に全部適用済みの DB に「適用済み」を一括記録する（新規 DB には使わない） |

`zz1`/`zz2` は番号を持たない補助 SQL で、索引・台帳には記録されません。

## 命名・ファイル構成のルール

- ファイル名: `NNNN_snake_case_slug.sql`（4 桁ゼロ埋め、既存ファイルの番号を再利用しない）
- **新規の変更は、SQL ファイル・`schema.prisma`・`INDEX.tsv`・`SCHEMA.sha256` を同じコミットに入れる**
- 自分自身のコミットハッシュは書けないため `INDEX.tsv` の `commit` 列は `-` のままにする。元コミットは
  ```
  git log --diff-filter=A --format='%h %ad %s' --date=short -1 -- apps/server/db/changes/NNNN_xxx.sql
  ```
  で引ける
- DDL 不要な `schema.prisma` の変更（コメント・`@default` のみ等）は `INDEX.tsv` に `file` 列 `-` の行で登録する
- `apps/server/prisma/migrations/`（Prisma 管理下、既存 20 件）は**凍結**。新規 SQL はここに置かない
- pgvector の embedding 列・索引は `apps/server/prisma/bootstrap.sql` の担当。ここには複製しない

## 各 SQL ファイルの共通フォーマット

```sql
-- ============================================================
-- NNNN / YYYY-MM-DD / commit <短ハッシュ or ->
-- サイクル: <サイクル名>
-- 内容: <変更の要約>
-- 注意: <backfill の要否・順序依存等。無ければ「特記事項なし」>
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/NNNN_xxx.sql
-- ============================================================
SET search_path TO public;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- 台帳（どのファイルからでも単独適用できるよう、ヘッダで作る）
CREATE TABLE IF NOT EXISTS "DbChange" (
  "name"      TEXT NOT NULL,
  "no"        INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy" TEXT,
  CONSTRAINT "DbChange_pkey" PRIMARY KEY ("name")
);

-- 誤爆ガード（3 段）
DO $$
DECLARE app_role text;
BEGIN
  IF to_regclass('public."Machine"') IS NULL THEN
    RAISE EXCEPTION 'DevRelay の DB ではありません（public."Machine" が無い）。新規 DB 構築はこのフォルダの担当外です';
  END IF;
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION 'superuser (%) では適用しないでください。アプリと同じロールに切り替えてから適用してください', current_user;
  END IF;
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Machine';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Machine" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

-- ここに DDL（すべて IF NOT EXISTS）

-- backfill がある場合: ALTER の前に列の存在を information_schema で確認し、
-- 「このファイルの実行で今まさに列を新規追加したとき」だけ backfill を実行する
-- （台帳の記録状態には依存しない。状態不明の DB で頭から全ファイルを流しても、
-- 既に列がある DB では既存データを一切書き換えない）:
--
-- DO $$
-- DECLARE column_existed boolean;
-- BEGIN
--   SELECT EXISTS (
--     SELECT 1 FROM information_schema.columns
--     WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'lastSeenAiAt'
--   ) INTO column_existed;
--
--   IF NOT column_existed THEN
--     ALTER TABLE "Session" ADD COLUMN "lastSeenAiAt" TIMESTAMP(3);
--   END IF;
--
--   IF NOT column_existed THEN
--     UPDATE "Session" s
--        SET "lastSeenAiAt" = (SELECT MAX(m."createdAt") FROM "Message" m
--                               WHERE m."sessionId" = s."id" AND m."role" = 'ai')
--      WHERE s."lastSeenAiAt" IS NULL;
--   END IF;
-- END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('NNNN_xxx.sql', NNNN, current_user)
ON CONFLICT ("name") DO NOTHING;
```

## 誤爆ガードの意味

1. **DevRelay の DB か**（`public."Machine"` の存在） — 接続先の取り違え・新規空 DB への誤用を止める
2. **superuser で流していないか** — 2026-11-11 の `CrossAskReset` 所有者ずれ事故（postgres ロールで CREATE TABLE）の再発防止
3. **既存表の所有者と一致しているか** — ①②を回避してもなお別ロールで流された場合の最後の砦

このフォルダの SQL は `OWNER TO` / `SET ROLE` / `CREATE EXTENSION` / `sudo` を一切含みません
（superuser 前提の操作は `apps/server/prisma/bootstrap.sql` の担当）。

## 冪等性

- DDL は全て `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。
- **backfill（`UPDATE`/`DELETE`）を含むファイルは、`ALTER` の前に `information_schema.columns` で
  列の存在を確認し、「このファイルの実行で今まさに列を新規追加したとき」だけ動かす。**
  台帳 `"DbChange"` の記録状態には依存しない（台帳が壊れていても・無くても安全）。
  これにより、状態不明の DB で `0001` から全ファイルを機械的に流しても、既に列がある DB では
  既存データを一切書き換えない（`tests/db-changes.test.mjs` がこの構造を静的に固定する）。

## 新規 DB の構築はこのフォルダの担当外

新規 DB の構築には `pnpm db:bootstrap:new-db-only`（`prisma db push` + `bootstrap.sql`）を使います。
このフォルダの SQL は**履歴の記録**であり、新規構築の経路ではありません
（ヘッダのガード①がこの誤用を構造的に止めます）。
