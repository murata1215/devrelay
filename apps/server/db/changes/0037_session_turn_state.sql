-- ============================================================
-- 0037 / 2026-11-24 / commit -
-- サイクル: スレッド状態バッジ（プラン作成済み/実行済み/回答済み）
-- 内容: Session.execCompletedAt / Session.planReadyAt を追加。
--       どちらも「サーバー自身が検知した事実」のみを記録する列（AI の文章を解釈しない）。
--       execCompletedAt は exec ターン完了時に agent-manager.ts が記録する。
--       planReadyAt は AI 応答のプラン提示マーカー行（<!-- devrelay:plan -->）検出時に記録する。
-- 注意: backfill は execCompletedAt のみ（既存 BuildLog の有無という事実から復元できるため）。
--       planReadyAt は推測で埋めない（AI の文章パターンマッチによる backfill は危険なため、
--       このサイクルの判断として意図的に見送る。導入後の新しいプランから正しく記録される）。
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない
--             （2026-11-11 の 42501 所有者ずれ事故の再発防止）
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0037_session_turn_state.sql
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

-- backfill は「このファイルの実行で今まさに列を新規追加したとき」だけ行う
-- （台帳の記録状態には依存しない。README.md の冪等性規約参照）。
DO $$
DECLARE column_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'execCompletedAt'
  ) INTO column_existed;

  IF NOT column_existed THEN
    ALTER TABLE "Session" ADD COLUMN "execCompletedAt" TIMESTAMP(3);
    ALTER TABLE "Session" ADD COLUMN "planReadyAt" TIMESTAMP(3);

    -- 「実行済み」は既存 BuildLog の有無という事実のみから復元できる（AI の文章は見ない）。
    -- 同一スレッドで複数回 exec していれば最初の完了時刻を使う（他の列と同じ「最初に到達した時刻」規約）。
    UPDATE "Session" s
       SET "execCompletedAt" = (
         SELECT MIN(bl."createdAt") FROM "BuildLog" bl WHERE bl."sessionId" = s."id"
       )
     WHERE EXISTS (SELECT 1 FROM "BuildLog" bl WHERE bl."sessionId" = s."id");
  END IF;
END $$;

-- 適用記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES ('0037_session_turn_state.sql', 37, current_user)
ON CONFLICT ("name") DO NOTHING;
