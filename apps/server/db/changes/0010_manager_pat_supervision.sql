-- ============================================================
-- 0010 / 2026-07-25 / commit b17975b
-- サイクル: org IP access control + Opus5/Sonnet5/Haiku4.5 models + enterprise supervision batch（統制 v2/v3、1コミットに複数サイクルのDDLが同居）
-- 内容: CREATE TABLE "ManagerAssignment"（#268） / "PersonalAccessToken"（#271） / "SupervisionAuditLog"（#270） + 
--       Organization.allowedIpRanges（#285） + Session.summary/summarizedAt（#270） + Message_sessionId_createdAt_idx（#272）
-- 注意: 1コミットに統制v2/v3の複数サイクル分のDDLが同居（プラン§4の粒度ルール「原則1コミット1ファイル」の例外。内訳は上記の内容欄）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0010_manager_pat_supervision.sql
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

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "allowedIpRanges" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "summary" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "summarizedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ManagerAssignment" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "managerUserId"  TEXT NOT NULL,
  "memberUserId"   TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManagerAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ManagerAssignment_managerUserId_memberUserId_key" ON "ManagerAssignment"("managerUserId", "memberUserId");
CREATE INDEX IF NOT EXISTS "ManagerAssignment_memberUserId_idx" ON "ManagerAssignment"("memberUserId");
CREATE INDEX IF NOT EXISTS "ManagerAssignment_managerUserId_idx" ON "ManagerAssignment"("managerUserId");
CREATE INDEX IF NOT EXISTS "ManagerAssignment_organizationId_idx" ON "ManagerAssignment"("organizationId");

CREATE TABLE IF NOT EXISTS "PersonalAccessToken" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PersonalAccessToken_tokenHash_key" ON "PersonalAccessToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "PersonalAccessToken_userId_idx" ON "PersonalAccessToken"("userId");

CREATE TABLE IF NOT EXISTS "SupervisionAuditLog" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "viewerUserId"   TEXT NOT NULL,
  "targetUserId"   TEXT NOT NULL,
  "action"         TEXT NOT NULL,
  "detail"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupervisionAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupervisionAuditLog_organizationId_createdAt_idx" ON "SupervisionAuditLog"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "SupervisionAuditLog_targetUserId_idx" ON "SupervisionAuditLog"("targetUserId");

CREATE INDEX IF NOT EXISTS "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManagerAssignment_managerUserId_fkey') THEN
    ALTER TABLE "ManagerAssignment" ADD CONSTRAINT "ManagerAssignment_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManagerAssignment_memberUserId_fkey') THEN
    ALTER TABLE "ManagerAssignment" ADD CONSTRAINT "ManagerAssignment_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManagerAssignment_organizationId_fkey') THEN
    ALTER TABLE "ManagerAssignment" ADD CONSTRAINT "ManagerAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonalAccessToken_userId_fkey') THEN
    ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0010_manager_pat_supervision.sql', 10, current_user)
ON CONFLICT ("name") DO NOTHING;
