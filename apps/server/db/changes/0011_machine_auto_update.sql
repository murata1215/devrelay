-- ============================================================
-- 0011 / 2026-08-14 / commit 13c7446
-- サイクル: #296 Agent 自動更新 + #295 ask/teamexec の宛先を Team 登録済みに限定
-- 内容: Machine に autoUpdate/lastAutoUpdateAt/lastAutoUpdateCommit/lastAutoUpdateStatus/autoUpdateAttempts を追加
-- 注意: 特記事項なし（単純な ADD COLUMN×5）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0011_machine_auto_update.sql
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

ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "autoUpdate" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "lastAutoUpdateAt" TIMESTAMP(3);
ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "lastAutoUpdateCommit" TEXT;
ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "lastAutoUpdateStatus" TEXT;
ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "autoUpdateAttempts" INTEGER NOT NULL DEFAULT 0;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0011_machine_auto_update.sql', 11, current_user)
ON CONFLICT ("name") DO NOTHING;
