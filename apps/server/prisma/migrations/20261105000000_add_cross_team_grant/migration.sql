-- クロスユーザー Team（別ユーザーのプロジェクトを招待・承認してチームに入れる機能）
-- Phase 1: ask のみ。teamexec は Phase 2 で execAllowed を解禁する。

-- AlterTable: Session に依頼者 userId を追加（既存行は NULL = 従来どおり「依頼者 = 所有者」）
ALTER TABLE "Session" ADD COLUMN "requestedByUserId" TEXT;

-- CreateTable
CREATE TABLE "CrossTeamInvite" (
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

-- CreateTable
CREATE TABLE "CrossTeamGrant" (
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

-- CreateTable
CREATE TABLE "CrossTeamAuditLog" (
    "id" TEXT NOT NULL,
    -- 'denied' の一部（組織不一致・組織未所属）は共通の組織が存在しないため null を許容する
    "organizationId" TEXT,
    "requesterUserId" TEXT NOT NULL,
    "executorUserId" TEXT NOT NULL,
    "teamId" TEXT,
    -- 'invite_sent' の時点では受入側がまだプロジェクトを選んでいないため null を許容する
    "projectId" TEXT,
    "sessionId" TEXT,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "grantId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossTeamAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrossTeamInvite_teamMemberId_key" ON "CrossTeamInvite"("teamMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "CrossTeamInvite_teamId_inviteeUserId_key" ON "CrossTeamInvite"("teamId", "inviteeUserId");

-- CreateIndex
CREATE INDEX "CrossTeamInvite_inviteeUserId_status_idx" ON "CrossTeamInvite"("inviteeUserId", "status");

-- CreateIndex
CREATE INDEX "CrossTeamInvite_teamId_idx" ON "CrossTeamInvite"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "CrossTeamGrant_teamMemberId_key" ON "CrossTeamGrant"("teamMemberId");

-- CreateIndex
CREATE INDEX "CrossTeamGrant_granteeUserId_idx" ON "CrossTeamGrant"("granteeUserId");

-- CreateIndex
CREATE INDEX "CrossTeamGrant_projectId_idx" ON "CrossTeamGrant"("projectId");

-- CreateIndex
CREATE INDEX "CrossTeamGrant_requesterUserId_idx" ON "CrossTeamGrant"("requesterUserId");

-- CreateIndex
CREATE INDEX "CrossTeamAuditLog_organizationId_createdAt_idx" ON "CrossTeamAuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CrossTeamAuditLog_executorUserId_createdAt_idx" ON "CrossTeamAuditLog"("executorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CrossTeamAuditLog_requesterUserId_createdAt_idx" ON "CrossTeamAuditLog"("requesterUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrossTeamInvite" ADD CONSTRAINT "CrossTeamInvite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossTeamGrant" ADD CONSTRAINT "CrossTeamGrant_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
