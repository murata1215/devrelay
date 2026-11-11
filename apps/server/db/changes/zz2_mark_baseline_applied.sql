-- ============================================================
-- zz2_mark_baseline_applied.sql — 「0001〜0031 は既に適用済み」を一括記録する（サイクルM1b）
--
-- ★★★ 警告 ★★★
-- これは「0001〜0031 の DDL が既に適用済みであることが zz1_verify.sql で確認できた DB」専用です。
-- 未適用の DB に流すと、未適用の変更が永久に「適用済み」として隠れます（最も静かで最も高い失敗）。
-- 下の DO ブロックが列の欠落を検出したら中断しますが、必ず先に zz1_verify.sql の結果を見てください。
-- 状態不明の DB（会社サーバー等）では流さないこと。欠落があれば 0001 から番号順に psql で流すこと。
--
-- 適用ロール: アプリと同じロール（本番は devrelay_user）。postgres / superuser では流さない。
-- 適用: psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/zz2_mark_baseline_applied.sql
-- ============================================================
SET search_path TO public;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

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
    RAISE EXCEPTION 'DevRelay の DB ではありません（public."Machine" が無い）。接続先 % を確認してください', current_database();
  END IF;
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION 'superuser (%) では適用しないでください。アプリと同じロールに切り替えてから適用してください', current_user;
  END IF;
  SELECT tableowner INTO app_role FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Machine';
  IF current_user <> app_role THEN
    RAISE EXCEPTION 'current_user=% は "Machine" の所有者 % と異なります', current_user, app_role;
  END IF;
END $$;

-- 突合ゲート（構造的な誤爆防止）: 0001〜0031 で追加された列の代表的なもの（0027 の
-- Session.lastSeenAiAt を含む）が実在しなければ中断する。zz1_verify.sql の列チェックの
-- 全件ではなく代表サンプルだが、0027（backfill を伴う最も実害が大きい変更）を必ず含める。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Session' AND column_name = 'lastSeenAiAt'
  ) THEN
    RAISE EXCEPTION '"Session"."lastSeenAiAt" が存在しません。0001〜0031 が未適用の可能性があります。' ||
      ' 先に zz1_verify.sql で全列を確認し、欠落があれば 0001 から番号順に適用してください（中断）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'CrossAskReset') THEN
    RAISE EXCEPTION '"CrossAskReset" テーブルが存在しません。0031 が未適用の可能性があります（中断）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'KnowledgeChunk') THEN
    RAISE EXCEPTION '"KnowledgeChunk" テーブルが存在しません。0024 が未適用の可能性があります（中断）';
  END IF;
END $$;

-- 0001〜0031 を「適用済み」として一括記録
INSERT INTO "DbChange" ("name", "no", "appliedBy")
VALUES
  ('0001_machine_disable_ask.sql', 1, 'baseline(2026-11-12)'),
  ('0002_tool_approval_is_question.sql', 2, 'baseline(2026-11-12)'),
  ('0003_project_description.sql', 3, 'baseline(2026-11-12)'),
  ('0004_project_display_name.sql', 4, 'baseline(2026-11-12)'),
  ('0005_notification_table.sql', 5, 'baseline(2026-11-12)'),
  ('0006_project_terminal_mode.sql', 6, 'baseline(2026-11-12)'),
  ('0007_project_terminal_mode_default_true.sql', 7, 'baseline(2026-11-12)'),
  ('0008_project_terminal_mode_default_false.sql', 8, 'baseline(2026-11-12)'),
  ('0009_organization_tables.sql', 9, 'baseline(2026-11-12)'),
  ('0010_manager_pat_supervision.sql', 10, 'baseline(2026-11-12)'),
  ('0011_machine_auto_update.sql', 11, 'baseline(2026-11-12)'),
  ('0012_machine_version_check.sql', 12, 'baseline(2026-11-12)'),
  ('0013_machine_running_code_stale.sql', 13, 'baseline(2026-11-12)'),
  ('0014_project_deleted_at.sql', 14, 'baseline(2026-11-12)'),
  ('0015_machine_claude_auth.sql', 15, 'baseline(2026-11-12)'),
  ('0016_session_council_mode.sql', 16, 'baseline(2026-11-12)'),
  ('0017_tool_approval_reason.sql', 17, 'baseline(2026-11-12)'),
  ('0018_message_human_text_meta.sql', 18, 'baseline(2026-11-12)'),
  ('0019_org_ai_defaults_session_scope.sql', 19, 'baseline(2026-11-12)'),
  ('0020_build_log_stop_reason.sql', 20, 'baseline(2026-11-12)'),
  ('0021_session_thread_management.sql', 21, 'baseline(2026-11-12)'),
  ('0022_machine_capability_config.sql', 22, 'baseline(2026-11-12)'),
  ('0023_session_kind_cancelled_at.sql', 23, 'baseline(2026-11-12)'),
  ('0024_knowledge_chunk_table.sql', 24, 'baseline(2026-11-12)'),
  ('0025_knowledge_clearance.sql', 25, 'baseline(2026-11-12)'),
  ('0027_session_last_seen_ai_at.sql', 27, 'baseline(2026-11-12)'),
  ('0028_notification_project_optional.sql', 28, 'baseline(2026-11-12)'),
  ('0029_cross_team_grant.sql', 29, 'baseline(2026-11-12)'),
  ('0030_team_subscription.sql', 30, 'baseline(2026-11-12)'),
  ('0031_cross_ask_reset.sql', 31, 'baseline(2026-11-12)')
ON CONFLICT ("name") DO NOTHING;
