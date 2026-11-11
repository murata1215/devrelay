-- ============================================================
-- 0029 / 2026-11-05 / commit 9f1990a
-- サイクル: クロスユーザーTeam(別ユーザーのエージェントとask連携)Phase0+1: 招待制CrossTeamGrant新設+executor/requester userId分離+既存バグ2件修正
-- 内容: CREATE TABLE "CrossTeamInvite"/"CrossTeamGrant"/"CrossTeamAuditLog" + Session.requestedByUserId + FK×2 + 索引9
-- 注意: 特記事項なし。prisma/migrations/20261105000000_add_cross_team_grant/migration.sql と同一内容
--       （9f1990a は 2026-11-05〜11-08 の 12 日分バッチコミットのため、既存 migration の日付区分に合わせて0029/0030に分割）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0029_cross_team_grant.sql
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

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "requestedByUserId" TEXT;

CREATE TABLE IF NOT EXISTS "CrossTeamInvite" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "inviterUserId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "askRequested" BOOLEAN NOT NULL DEFAULT true,
    "execRequested" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "teamMemberId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CrossTeamInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrossTeamGrant" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "askAllowed" BOOLEAN NOT NULL DEFAULT false,
    "execAllowed" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "inviteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CrossTeamGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrossTeamAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "requesterUserId" TEXT NOT NULL,
    "executorUserId" TEXT NOT NULL,
    "teamId" TEXT,
    "projectId" TEXT,
    "sessionId" TEXT,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "grantId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrossTeamAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CrossTeamInvite_teamMemberId_key" ON "CrossTeamInvite"("teamMemberId");
CREATE UNIQUE INDEX IF NOT EXISTS "CrossTeamInvite_teamId_inviteeUserId_key" ON "CrossTeamInvite"("teamId", "inviteeUserId");
CREATE INDEX IF NOT EXISTS "CrossTeamInvite_inviteeUserId_status_idx" ON "CrossTeamInvite"("inviteeUserId", "status");
CREATE INDEX IF NOT EXISTS "CrossTeamInvite_teamId_idx" ON "CrossTeamInvite"("teamId");

CREATE UNIQUE INDEX IF NOT EXISTS "CrossTeamGrant_teamMemberId_key" ON "CrossTeamGrant"("teamMemberId");
CREATE INDEX IF NOT EXISTS "CrossTeamGrant_granteeUserId_idx" ON "CrossTeamGrant"("granteeUserId");
CREATE INDEX IF NOT EXISTS "CrossTeamGrant_projectId_idx" ON "CrossTeamGrant"("projectId");
CREATE INDEX IF NOT EXISTS "CrossTeamGrant_requesterUserId_idx" ON "CrossTeamGrant"("requesterUserId");

CREATE INDEX IF NOT EXISTS "CrossTeamAuditLog_organizationId_createdAt_idx" ON "CrossTeamAuditLog"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrossTeamAuditLog_executorUserId_createdAt_idx" ON "CrossTeamAuditLog"("executorUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrossTeamAuditLog_requesterUserId_createdAt_idx" ON "CrossTeamAuditLog"("requesterUserId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrossTeamInvite_teamId_fkey') THEN
    ALTER TABLE "CrossTeamInvite" ADD CONSTRAINT "CrossTeamInvite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CrossTeamGrant_teamMemberId_fkey') THEN
    ALTER TABLE "CrossTeamGrant" ADD CONSTRAINT "CrossTeamGrant_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0029_cross_team_grant.sql', 29, current_user)
ON CONFLICT ("name") DO NOTHING;
