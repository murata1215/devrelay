-- ============================================================
-- 0025 / 2026-10-11 / commit 815c504
-- サイクル: feat(knowledge): 高辻ナレッジ サイクル2 — 数値権限(0〜10) + 案件の壁(compartment) + 検索監査 + 組織共通 embedding キー
-- 内容: Project.defaultLevel/defaultCompartment + Session.level/compartment を追加 + CREATE TABLE "UserClearance"
-- 注意: compartments は NOT NULL を付けない（prisma migrate diff --from-empty --to-schema-datamodel で実測して合わせた仕様。doc/migrations/knowledge2_classification.md 参照）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0025_knowledge_clearance.sql
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

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "defaultLevel" INTEGER;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "defaultCompartment" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "level" INTEGER;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "compartment" TEXT;

CREATE TABLE IF NOT EXISTS "UserClearance" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "readLevel"    INTEGER NOT NULL DEFAULT 0,
  "writeLevel"   INTEGER NOT NULL DEFAULT 0,
  "compartments" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "updatedBy"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserClearance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserClearance_userId_key" ON "UserClearance"("userId");

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0025_knowledge_clearance.sql', 25, current_user)
ON CONFLICT ("name") DO NOTHING;
