-- ============================================================
-- 0039 / 2026-11-26 / commit -
-- サイクル: MCP スレッド分離
-- 内容: Session.origin を追加し、MCP と対話画面で作られたスレッドを区別する
-- 注意: 既存行は推測で分類せず、interactive として扱う
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0039_session_origin.sql
-- ============================================================
SET search_path TO public;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS "DbChange" (
  "name" TEXT NOT NULL,
  "no" INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy" TEXT,
  CONSTRAINT "DbChange_pkey" PRIMARY KEY ("name")
);

DO $$
DECLARE app_role text;
BEGIN
  IF to_regclass('public."Machine"') IS NULL THEN
    RAISE EXCEPTION 'DevRelay の DB ではありません（public."Machine" が無い）。新規 DB 構築はこのフォルダの担当外です';
  END IF;
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION 'superuser (%) では適用しないでください。アプリと同じロールに切り替えてから適用してください', current_user;
  END IF;
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Session';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Session" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'interactive';
CREATE INDEX IF NOT EXISTS "Session_userId_projectId_origin_lastActiveAt_idx"
  ON "Session" ("userId", "projectId", "origin", "lastActiveAt" DESC);

INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0039_session_origin.sql', 39, current_user)
ON CONFLICT ("name") DO NOTHING;
