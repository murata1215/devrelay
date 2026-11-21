-- ============================================================
-- 0019 / 2026-09-08 / commit 9c49644
-- サイクル: #376 MCP submission 単位の会話セッション境界導入（#371〜#375 の未コミット分を含む）
-- 内容: Organization.aiModelDefaults + OrganizationMember.canOverrideAiSettings + 
--       Session.planTurnId/planAiSessionId/planAiTool/approvedAt を追加
-- 注意: 特記事項なし（単純な ADD COLUMN×6）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0019_org_ai_defaults_session_scope.sql
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

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "aiModelDefaults" TEXT;
ALTER TABLE "OrganizationMember" ADD COLUMN IF NOT EXISTS "canOverrideAiSettings" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planTurnId" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planAiSessionId" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "planAiTool" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0019_org_ai_defaults_session_scope.sql', 19, current_user)
ON CONFLICT ("name") DO NOTHING;
