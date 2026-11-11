-- ============================================================
-- 0009 / 2026-07-20 / commit 1152120
-- サイクル: enterprise organization mode v1 (#264)
-- 内容: CREATE TABLE "Organization"（10列）/ "OrganizationMember"（6列）+ FK×3 + 索引
-- 注意: 当時の実 DB 構造（2026-09-08 の 0019 適用前の姿）で記録する。allowedIpRanges（#285）・
--       aiModelDefaults（#372）・canOverrideAiSettings（#372）は後続（0010/0019）で追加されるため、
--       本ファイルでは含めない（元コミットの時系列どおりに再現する）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0009_organization_tables.sql
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

CREATE TABLE IF NOT EXISTS "Organization" (
  "id"               TEXT NOT NULL,
  "orgCode"          TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "joinPasswordHash" TEXT NOT NULL,
  "logo"             BYTEA,
  "logoMimeType"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_orgCode_key" ON "Organization"("orgCode");

CREATE TABLE IF NOT EXISTS "OrganizationMember" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "role"           TEXT NOT NULL DEFAULT 'member',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrganizationMember_organizationId_idx" ON "OrganizationMember"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationMember_userId_key" ON "OrganizationMember"("userId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationMember_organizationId_fkey') THEN
    ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrganizationMember_userId_fkey') THEN
    ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0009_organization_tables.sql', 9, current_user)
ON CONFLICT ("name") DO NOTHING;
