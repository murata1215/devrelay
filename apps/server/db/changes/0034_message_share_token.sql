-- ============================================================
-- 0034 / 2026-11-23 / commit -
-- サイクル: 応答の書式（要約＋詳細リンク）サイクル
-- 内容: Message に shareToken（unique）/ shareExpiresAt を追加（公開共有リンク用、すべて NULL 許容）
-- 注意: 特記事項なし（列追加のみ。backfill しない＝既存メッセージには共有リンクを発行しない）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0034_message_share_token.sql
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

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "shareToken" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "shareExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "Message_shareToken_key" ON "Message"("shareToken");

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0034_message_share_token.sql', 34, current_user)
ON CONFLICT ("name") DO NOTHING;
