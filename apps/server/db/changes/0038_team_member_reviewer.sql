-- ============================================================
-- 0038 / 2026-11-26 / commit -
-- サイクル: 一回レビュー
-- 内容: TeamMember にレビュー担当フラグを追加し、Team ごとに 1 人へ制限する
-- 注意: 既存 Team は全て isReviewer=false のまま（backfill 不要）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0038_team_member_reviewer.sql
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
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Machine';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Machine" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

ALTER TABLE "TeamMember" ADD COLUMN IF NOT EXISTS "isReviewer" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "TeamMember_one_reviewer_per_team"
  ON "TeamMember" ("teamId") WHERE "isReviewer" = true;

INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0038_team_member_reviewer.sql', 38, current_user)
ON CONFLICT ("name") DO NOTHING;
