-- 公開型クロスユーザー Team（Phase A: サーバー + 認可のみ。WebUI は Phase B）
-- Team を公開し、同一組織内の利用者が選んで購読できるようにする。
-- 購読は CrossTeamGrant とは別テーブル（TeamSubscription）で表現し、実 grant 行は作らない
-- （購読者数 × チーム規模の行の増殖とチーム編集時の同期処理を避けるため）。

-- AlterTable: Team に公開フラグを追加（既定 'private' = 既存行は全て非公開のまま）
ALTER TABLE "Team" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

-- CreateTable
CREATE TABLE "TeamSubscription" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "subscriberUserId" TEXT NOT NULL,
    -- 購読時点のスナップショット（実行時は OrganizationMember を再検証する）
    "organizationId" TEXT NOT NULL,
    "askAllowed" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamSubscription_teamId_subscriberUserId_key" ON "TeamSubscription"("teamId", "subscriberUserId");

-- CreateIndex
CREATE INDEX "TeamSubscription_subscriberUserId_idx" ON "TeamSubscription"("subscriberUserId");

-- CreateIndex
CREATE INDEX "TeamSubscription_teamId_idx" ON "TeamSubscription"("teamId");

-- AddForeignKey
ALTER TABLE "TeamSubscription" ADD CONSTRAINT "TeamSubscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
