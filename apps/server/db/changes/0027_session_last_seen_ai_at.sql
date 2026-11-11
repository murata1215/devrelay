-- ============================================================
-- 0027 / 2026-10-22 / commit d3f3979
-- サイクル: 会話既読状態のサーバー管理化 + Notification.sessionId 追加
-- 内容: Session.lastSeenAiAt + Notification.sessionId を追加（既読のサーバー管理化、backfill あり）
-- 注意: backfill あり。ALTER の前に Session.lastSeenAiAt の列存在を確認し、
--       「この実行で今まさに列を追加したとき」だけ既存スレッドの既読状態を埋める
--       （台帳の記録状態には依存しない。README.md の冪等性の節参照）
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0027_session_last_seen_ai_at.sql
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

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

DO $$
DECLARE column_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'lastSeenAiAt'
  ) INTO column_existed;

  IF NOT column_existed THEN
    ALTER TABLE "Session" ADD COLUMN "lastSeenAiAt" TIMESTAMP(3);
  END IF;

  -- backfill は「この実行で今まさに列を新規追加したとき」だけ行う（台帳の記録状態に依存しない。
  -- 既に列がある DB では既存の既読状態を一切書き換えない）
  IF NOT column_existed THEN
    UPDATE "Session" s
       SET "lastSeenAiAt" = (SELECT MAX(m."createdAt") FROM "Message" m
                              WHERE m."sessionId" = s."id" AND m."role" = 'ai')
     WHERE s."lastSeenAiAt" IS NULL;
  END IF;
END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0027_session_last_seen_ai_at.sql', 27, current_user)
ON CONFLICT ("name") DO NOTHING;
