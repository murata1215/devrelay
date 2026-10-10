-- DevRelay DB ブートストラップ用 SQL（社内オンプレ移設対応）
--
-- prisma/migrations/ には含まれていない pgvector 関連オブジェクトを冪等に作成する。
-- 現行本番 DB（devrelay.io）を調査した結果、migration 履歴に無い手作業オブジェクトは
-- 以下の 6 つのみ（2026-10-10 時点で確認済み。トリガ・関数は 0 件、他の手動インデックスも無し）:
--   1. 拡張        vector 0.6.0
--   2. 列          MessageFile.embedding  vector(1536)
--   3. 列          AgentDocument.embedding vector(1536)
--   4. 索引        idx_messagefile_embedding (ivfflat, vector_cosine_ops, lists=100)
--   5. 列          KnowledgeChunk.embedding vector(1536)
--   6. 索引        idx_knowledgechunk_embedding (hnsw, vector_cosine_ops, m=16, ef_construction=64)
--
-- 実行方法: `pnpm db:bootstrap`（package.json の db:bootstrap スクリプトが
-- `prisma db push` → 本ファイルの適用 → を行う）。
-- 前提条件: `CREATE EXTENSION vector` は superuser 権限が必要。
-- 社内で既存 PostgreSQL インスタンスに相乗りする場合、DB 作成後にまず DBA へ本ファイルの
-- 冒頭（拡張作成）だけ先に依頼するか、DevRelay 専用ロールに一時的に superuser を付与して
-- 実行後に剥奪すること。
--
-- 冪等性: 本ファイルは既存本番 DB に対して再実行しても差分ゼロであること（検証済み）。
-- AgentDocument.embedding には現行本番と同じくインデックスを追加しない（非対称のまま揃える）。
--
-- ⚠️ 稼働中 DB への注意（高辻ナレッジ サイクル1 で実証）: `pnpm db:bootstrap` は内部で
-- `prisma db push` を実行する。これは schema.prisma に書けない `embedding` 列（Prisma 非対応型）
-- を「スキーマに無い列」と見なして **DROP COLUMN する**（`prisma migrate diff` で実証済み）。
-- 既に稼働している DB に対して本ファイルの 2〜6 を追加・変更する場合は、`pnpm db:bootstrap`
-- （`prisma db push` 経由）ではなく `npx prisma db execute --stdin` で本ファイルの該当セクションだけ
-- 直接適用すること（`db:bootstrap` は新規 DB 構築専用）。

-- 1. pgvector 拡張の有効化（DB 単位。サーバーに pgvector が入っていても DB ごとに必要）
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. MessageFile.embedding（添付ファイルのセマンティック検索用埋め込みベクトル）
-- text-embedding-3-small は 1536 次元
ALTER TABLE "MessageFile" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 3. AgentDocument.embedding（エージェントドキュメントのセマンティック検索用埋め込みベクトル）
ALTER TABLE "AgentDocument" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 4. MessageFile.embedding への ivfflat インデックス（コサイン類似度検索の高速化）
-- lists=100 は現行本番の実測値をそのまま踏襲（データ量が大きく異なる場合は将来的に見直すこと）
CREATE INDEX IF NOT EXISTS idx_messagefile_embedding
  ON "MessageFile" USING ivfflat (embedding vector_cosine_ops) WITH (lists = '100');

-- 5. KnowledgeChunk.embedding（高辻ナレッジ サイクル1: 会話ターンのセマンティック検索用埋め込みベクトル）
ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 6. KnowledgeChunk.embedding への HNSW インデックス
-- 行が継続的に増え続けるテーブルのため、学習（training）が必要な ivfflat ではなく HNSW を使う
-- （pgvector 0.5.0+ で利用可。本番は 0.6.0）。m=16 / ef_construction=64 は pgvector の既定値。
CREATE INDEX IF NOT EXISTS idx_knowledgechunk_embedding
  ON "KnowledgeChunk" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
