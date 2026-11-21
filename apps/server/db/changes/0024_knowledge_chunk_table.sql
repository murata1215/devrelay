-- ============================================================
-- 0024 / 2026-10-10 / commit 6ae9c8e
-- サイクル: feat(knowledge): 高辻ナレッジ サイクル1 — KnowledgeChunk + ハイブリッド検索 + MCP search_knowledge
-- 内容: CREATE TABLE "KnowledgeChunk"（14列）+ unique 1 + 索引 3
-- 注意: embedding vector(1536) 列と HNSW 索引（idx_knowledgechunk_embedding）は 
--       apps/server/prisma/bootstrap.sql のセクション5・6の担当。本ファイルでは作らない（重複させない）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0024_knowledge_chunk_table.sql
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

CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
  "id"              TEXT NOT NULL,
  "sourceType"      TEXT NOT NULL,
  "sourceId"        TEXT NOT NULL,
  "chunkIndex"      INTEGER NOT NULL,
  "chunkCount"      INTEGER NOT NULL,
  "userId"          TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "sessionId"       TEXT NOT NULL,
  "userMessageId"   TEXT,
  "textContent"     TEXT NOT NULL,
  "embeddingStatus" TEXT NOT NULL DEFAULT 'none',
  "occurredAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeChunk_sourceType_sourceId_chunkIndex_key" ON "KnowledgeChunk"("sourceType", "sourceId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_userId_occurredAt_idx" ON "KnowledgeChunk"("userId", "occurredAt");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_projectId_idx" ON "KnowledgeChunk"("projectId");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_sessionId_idx" ON "KnowledgeChunk"("sessionId");

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0024_knowledge_chunk_table.sql', 24, current_user)
ON CONFLICT ("name") DO NOTHING;
