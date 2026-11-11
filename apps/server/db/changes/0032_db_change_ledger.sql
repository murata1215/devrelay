-- ============================================================
-- 0032 / 2026-11-12 / commit -
-- サイクル: サイクルM1 — DB 変更履歴の一元化
-- 内容: DB 変更の適用台帳 "DbChange" を新設する。
--       以後の DB 変更（apps/server/db/changes/NNNN_*.sql）は、本ファイルと同じ
--       ヘッダ（誤爆ガード + CREATE TABLE IF NOT EXISTS "DbChange"）を持ち、
--       末尾で自分のファイル名を "DbChange" に記録する。
-- 注意: 本ファイル自体は "DbChange" テーブルを作る以外の DDL を持たない
--       （テーブル作成はヘッダのガード直前で全ファイル共通で行うため、ここでは重複させない）。
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0032_db_change_ledger.sql
-- ============================================================
SET search_path TO public;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- 台帳（本ファイルのヘッダ。以後の全ファイルで共通のブロックとして繰り返す）
CREATE TABLE IF NOT EXISTS "DbChange" (
  "name"      TEXT NOT NULL,
  "no"        INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy" TEXT,
  CONSTRAINT "DbChange_pkey" PRIMARY KEY ("name")
);

-- 誤爆ガード（3 段。apps/server/db/changes/README.md 参照）
DO $$
DECLARE app_role text;
BEGIN
  IF to_regclass('public."Machine"') IS NULL THEN
    RAISE EXCEPTION 'DevRelay の DB ではありません（public."Machine" が無い）。接続先 % を確認してください。新規 DB 構築はこのフォルダの担当外です（README.md 参照）', current_database();
  END IF;
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION 'superuser (%) では適用しないでください。アプリと同じロールに切り替えてから適用してください', current_user;
  END IF;
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Machine';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Machine" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

-- このファイル固有の DDL は無し（台帳テーブル自体の新設が内容のため、ヘッダの CREATE TABLE で完結）。

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0032_db_change_ledger.sql', 32, current_user)
ON CONFLICT ("name") DO NOTHING;
